import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  HttpRequestSchema,
  ancestorFolders,
  createCollection,
  createEnvironment,
  descendantIds,

  secretKeys,
  type Collection,
  type Environment,
  type HistoryEntry,
  type HttpRequest,
  type SecretVault,
} from '@reqvyn/core';
import { addFolder, addRequest, deleteNode, duplicateFolder, duplicateRequest, extractEntitySecrets, persistMutation, renameNode } from '@reqvyn/collection-engine';
import {
  PACKAGE_EXTENSION,
  applyOpenApiRefresh,
  buildPackage,
  exportCurl,
  exportCurlScript,
  exportNative,
  exportOpenApi,
  exportPostman,
  importFiles,
  mergeCollections,
  parseClipboard,
  planOpenApiRefresh,
  previewImport,
  remapIds,
  type ImportResult,
  type MergeStrategy,
} from '@reqvyn/import-export';
import { errorMessage, newId } from '@reqvyn/shared';
import type { StoreEntry, StoreManager } from './stores.js';
import { GLOBALS_ID, type AppState, type FavoriteRef } from './state.js';
import type { Services } from './services.js';
import type { CollectionNode, CollectionsTree, EnvironmentNode, EnvironmentsTree, FavoritesTree, HistoryTree } from './trees.js';
import type { SyncManager, SyncNode } from './sync.js';
import { RequestPanel, type PanelHost } from './panels/requestPanel.js';
import { EnvironmentPanel } from './panels/environmentPanel.js';
import { ContainerPanel } from './panels/containerPanel.js';
import { RunnerPanel } from './panels/runnerPanel.js';
import { pickCollectionTarget, pickStore } from './pickers.js';

export interface CommandDeps {
  host: PanelHost;
  services: Services;
  stores: StoreManager;
  state: AppState;
  vault: SecretVault;
  sync: SyncManager;
  trees: { collections: CollectionsTree; history: HistoryTree; environments: EnvironmentsTree; favorites: FavoritesTree };
  collectionsView: vscode.TreeView<CollectionNode>;
}

type ReqNode = Extract<CollectionNode, { kind: 'request' }>;
type ContainerNode = Extract<CollectionNode, { kind: 'collection' | 'folder' }>;

/** Store inline auth secrets of every entity in the vault and replace them with `{{$secret:…}}`. */
export async function vaultCollectionSecrets(c: Collection, vault: SecretVault): Promise<{ collection: Collection; moved: number }> {
  let moved = 0;
  const take = async <T extends Parameters<typeof extractEntitySecrets>[0]>(e: T): Promise<T> => {
    const { entity, secrets } = extractEntitySecrets(e);
    for (const s of secrets) await vault.set(secretKeys.named(s.name), s.value);
    moved += secrets.length;
    return entity;
  };
  const { folders, requests, ...info } = c;
  const nextInfo = await take(info);
  const nextFolders = [];
  for (const f of folders) nextFolders.push(await take(f));
  const nextRequests = [];
  for (const r of requests) nextRequests.push(await take(r));
  return { collection: { ...c, ...nextInfo, folders: nextFolders, requests: nextRequests }, moved };
}

/** Move values of secret environment rows into the vault (files only keep the key). */
export async function vaultEnvironmentSecrets(env: Environment, vault: SecretVault): Promise<number> {
  let n = 0;
  for (const v of env.variables) {
    if (v.secret && v.value) {
      await vault.set(secretKeys.environmentVariable(env.id, v.key), v.value);
      n++;
    }
  }
  return n;
}

export function registerCommands(context: vscode.ExtensionContext, d: CommandDeps): void {
  const { host, stores, state, vault } = d;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- handlers receive heterogeneous tree nodes / URIs
  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await fn(...args);
        } catch (e) {
          void vscode.window.showErrorMessage(`REQVYN: ${errorMessage(e)}`);
        }
      }),
    );

  /** Tree commands invoked from the command palette get no node: fall back to the selection. */
  const selected = <K extends CollectionNode['kind']>(node: unknown, kinds: K[]): Extract<CollectionNode, { kind: K }> | undefined => {
    const n = (node as CollectionNode | undefined) ?? d.collectionsView.selection[0];
    return n && (kinds as string[]).includes(n.kind) ? (n as Extract<CollectionNode, { kind: K }>) : undefined;
  };

  const refreshCollections = () => d.trees.collections.refresh();

  // --- requests & collections ----------------------------------------------------------------

  reg('reqvyn.newRequest', async (node?: CollectionNode) => {
    const target = selected(node, ['collection', 'folder', 'request']);
    if (!target) {
      await RequestPanel.openScratch(host);
      return;
    }
    const { store } = stores.get(target.storeId);
    const c = await store.loadCollection(target.collectionId);
    const parentId = target.kind === 'folder' ? target.folderId : target.kind === 'request' ? (c.requests.find((r) => r.id === target.requestId)?.parentId ?? null) : null;
    const name = await vscode.window.showInputBox({ title: 'New request', value: 'New Request' });
    if (!name) return;
    const m = addRequest(c, { name }, parentId);
    await persistMutation(store, m);
    refreshCollections();
    await RequestPanel.open(host, { storeId: target.storeId, collectionId: c.id, requestId: m.request.id });
  });

  reg('reqvyn.newScratchRequest', () => RequestPanel.openScratch(host));

  reg('reqvyn.newFolder', async (node?: CollectionNode) => {
    const target = selected(node, ['collection', 'folder']) ?? (await pickContainer(stores));
    if (!target) return;
    const name = await vscode.window.showInputBox({ title: 'New folder', value: 'New Folder' });
    if (!name) return;
    const { store } = stores.get(target.storeId);
    const c = await store.loadCollection(target.collectionId);
    await persistMutation(store, addFolder(c, name, target.kind === 'folder' ? target.folderId : null));
    refreshCollections();
  });

  reg('reqvyn.newCollection', async (node?: CollectionNode) => {
    const entry = node?.kind === 'store' ? stores.get(node.storeId) : await pickStore(stores, 'Create the collection in');
    if (!entry) return;
    const name = await vscode.window.showInputBox({ title: 'New collection', value: 'New Collection' });
    if (!name) return;
    await entry.store.saveCollection(createCollection({ name }));
    refreshCollections();
  });

  reg('reqvyn.openRequest', async (node?: CollectionNode) => {
    const n = selected(node, ['request']);
    if (n) await RequestPanel.open(host, { storeId: n.storeId, collectionId: n.collectionId, requestId: n.requestId });
  });

  reg('reqvyn.rename', async (node?: CollectionNode) => {
    const n = selected(node, ['collection', 'folder', 'request']);
    if (!n) return;
    const { store } = stores.get(n.storeId);
    const c = await store.loadCollection(n.collectionId);
    const current = n.kind === 'collection' ? c.name : n.kind === 'folder' ? c.folders.find((f) => f.id === n.folderId)?.name : c.requests.find((r) => r.id === n.requestId)?.name;
    const name = await vscode.window.showInputBox({ title: 'Rename', value: current, validateInput: (s) => (s.trim() ? undefined : 'Name is required') });
    if (!name || name === current) return;
    if (n.kind === 'collection') {
      const { folders: _f, requests: _r, ...info } = c;
      await store.saveCollectionInfo({ ...info, name: name.trim() });
    } else {
      await persistMutation(store, renameNode(c, n.kind === 'folder' ? n.folderId : n.requestId, name.trim()));
    }
    refreshCollections();
    await RequestPanel.reloadFromStore(n.storeId, n.collectionId);
  });

  reg('reqvyn.delete', async (node?: CollectionNode, nodes?: CollectionNode[]) => {
    const list = (nodes?.length ? nodes : [selected(node, ['collection', 'folder', 'request'])]).filter((x): x is CollectionNode => !!x && x.kind !== 'store' && x.kind !== 'problem');
    if (!list.length) return;
    const what = list.length > 1 ? `${list.length} items` : await nodeLabel(stores, list[0]!);
    const ok = await vscode.window.showWarningMessage(`Delete ${what}? This cannot be undone (unless the files are under version control).`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    for (const n of list) {
      if (n.kind === 'store' || n.kind === 'problem') continue;
      const { store } = stores.get(n.storeId);
      if (n.kind === 'collection') {
        await store.deleteCollection(n.collectionId);
        RequestPanel.closeFor(n.storeId, n.collectionId);
        ContainerPanel.closeFor(n.storeId, n.collectionId);
        continue;
      }
      const c = await store.loadCollection(n.collectionId).catch(() => undefined);
      if (!c) continue;
      const id = n.kind === 'folder' ? n.folderId : n.requestId;
      if (!c.folders.some((f) => f.id === id) && !c.requests.some((r) => r.id === id)) continue;
      const removed = n.kind === 'folder' ? descendantIds(c, id) : { folders: [], requests: [id] };
      await persistMutation(store, deleteNode(c, id));
      RequestPanel.closeFor(n.storeId, n.collectionId, removed.requests);
      ContainerPanel.closeFor(n.storeId, n.collectionId, [...removed.folders, ...(n.kind === 'folder' ? [id] : [])]);
    }
    await pruneFavorites();
    refreshCollections();
  });

  reg('reqvyn.duplicate', async (node?: CollectionNode) => {
    const n = selected(node, ['collection', 'folder', 'request']);
    if (!n) return;
    const { store } = stores.get(n.storeId);
    const c = await store.loadCollection(n.collectionId);
    if (n.kind === 'collection') {
      const { collection } = remapIds({ ...c, name: `${c.name} (copy)` });
      await store.saveCollection(collection);
    } else if (n.kind === 'folder') {
      await persistMutation(store, duplicateFolder(c, n.folderId));
    } else {
      const m = duplicateRequest(c, n.requestId);
      await persistMutation(store, m);
      await RequestPanel.open(host, { storeId: n.storeId, collectionId: c.id, requestId: m.request.id });
    }
    refreshCollections();
  });

  reg('reqvyn.copyAsCurl', async (node?: CollectionNode) => {
    const n = selected(node, ['request']);
    if (!n) return;
    const c = await stores.loadCollection(n.storeId, n.collectionId);
    const r = c.requests.find((x) => x.id === n.requestId);
    if (!r) return;
    const out = exportCurl(r, { collection: c, multiline: true });
    await vscode.env.clipboard.writeText(out.text);
    vscode.window.setStatusBarMessage('REQVYN: cURL copied (variables unresolved, secrets as placeholders)', 4000);
  });

  reg('reqvyn.favorite.toggle', async (node?: CollectionNode | FavoriteRef) => {
    let ref: FavoriteRef | undefined;
    if (node && 'requestId' in node && !('kind' in node)) ref = node;
    else {
      const n = selected(node, ['request']);
      if (!n) return;
      const c = await stores.loadCollection(n.storeId, n.collectionId);
      const r = c.requests.find((x) => x.id === n.requestId);
      if (!r) return;
      ref = { storeId: n.storeId, collectionId: c.id, requestId: r.id, name: r.name, method: r.method };
    }
    const on = await state.toggleFavorite(ref);
    vscode.window.setStatusBarMessage(on ? `★ ${ref.name} added to favorites` : `${ref.name} removed from favorites`, 3000);
    refreshCollections();
  });

  const pruneFavorites = async () => {
    const known = new Set<string>();
    for (const { entry, collection } of await stores.allCollections()) for (const r of collection.requests) known.add(`${entry.id}|${r.id}`);
    await state.pruneFavorites((f) => known.has(`${f.storeId}|${f.requestId}`));
  };

  reg('reqvyn.settings', async (node?: CollectionNode) => {
    const n = selected(node, ['collection', 'folder', 'request']);
    if (!n) return;
    if (n.kind === 'request') {
      const c = await stores.loadCollection(n.storeId, n.collectionId);
      const parentId = c.requests.find((r) => r.id === n.requestId)?.parentId;
      await ContainerPanel.open(host, { storeId: n.storeId, collectionId: n.collectionId, folderId: parentId ?? undefined });
      return;
    }
    await ContainerPanel.open(host, { storeId: n.storeId, collectionId: n.collectionId, folderId: n.kind === 'folder' ? n.folderId : undefined });
  });

  reg('reqvyn.run', async (node?: CollectionNode) => {
    const n = selected(node, ['collection', 'folder']) ?? (await pickContainer(stores));
    if (!n) return;
    await RunnerPanel.open(host, { storeId: n.storeId, collectionId: n.collectionId, folderId: n.kind === 'folder' ? n.folderId : null });
  });

  reg('reqvyn.send', async () => {
    const p = RequestPanel.active() ?? RequestPanel.all()[0];
    if (!p) {
      void vscode.window.showInformationMessage('Open a request first.');
      return;
    }
    await p.sendNow();
  });

  reg('reqvyn.refresh', async () => {
    refreshCollections();
    d.trees.environments.refresh();
    d.trees.history.refresh();
    d.trees.favorites.refresh();
    d.sync.refresh();
  });

  reg('reqvyn.filter', async () => {
    const text = await vscode.window.showInputBox({ title: 'Filter collections', prompt: 'Matches request names, methods and URLs' });
    if (text !== undefined) d.trees.collections.setFilter(text);
  });
  reg('reqvyn.clearFilter', () => d.trees.collections.setFilter(''));

  reg('reqvyn.quickOpen', async () => {
    const all = await stores.allCollections();
    type Item = vscode.QuickPickItem & { ref?: ReqNode };
    const items: Item[] = [];
    const favs = new Set(state.favorites().map((f) => f.requestId));
    for (const { entry, collection } of all) {
      for (const r of collection.requests) {
        const path = [collection.name, ...ancestorFolders(collection, r.parentId).map((f) => f.name)].join(' / ');
        items.push({
          label: `${favs.has(r.id) ? '$(star-full) ' : ''}${r.method} ${r.name}`,
          description: stores.list().length > 1 ? `${path} · ${entry.label}` : path,
          detail: r.url,
          ref: { kind: 'request', storeId: entry.id, collectionId: collection.id, requestId: r.id },
        });
      }
    }
    if (!items.length) {
      void vscode.window.showInformationMessage('No saved requests yet.');
      return;
    }
    const pick = await vscode.window.showQuickPick(items, { title: 'Open request', placeHolder: 'Search by name, method, URL or folder', matchOnDescription: true, matchOnDetail: true });
    if (pick?.ref) await RequestPanel.open(host, pick.ref);
  });

  // --- workspace -----------------------------------------------------------------------------

  reg('reqvyn.initWorkspace', async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      void vscode.window.showInformationMessage('Open a folder first. Without a workspace, collections are stored in your personal store.');
      return;
    }
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Create .reqvyn storage in' });
    if (!folder) return;
    const entry = await stores.openFolder(folder, true);
    if (entry) void vscode.window.showInformationMessage(`REQVYN storage ready in ${entry.store.root}. Commit it to share collections with your team – secrets are never written there.`);
  });

  // --- environments --------------------------------------------------------------------------

  reg('reqvyn.environment.select', async (storeIdArg?: string) => {
    const entry = typeof storeIdArg === 'string' ? stores.get(storeIdArg) : await pickStore(stores, 'Environments of');
    if (!entry) return;
    const envs = await stores.environments(entry.id);
    const active = state.activeEnvironmentId(entry.id);
    const items = [
      { label: '$(circle-slash) No environment', id: null as string | null, picked: !active },
      ...envs.map((e) => ({ label: `${e.id === active ? '$(pass-filled) ' : ''}${e.name}`, description: `${e.variables.length} variable(s)`, id: e.id as string | null, picked: e.id === active })),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `Active environment (${entry.label})` });
    if (!pick) return;
    await state.setActiveEnvironment(entry.id, pick.id);
  });

  reg('reqvyn.environment.setActive', async (node?: EnvironmentNode) => {
    if (node?.kind !== 'environment') return;
    const active = state.activeEnvironmentId(node.storeId) === node.environmentId;
    await state.setActiveEnvironment(node.storeId, active ? null : node.environmentId);
  });

  reg('reqvyn.environment.open', async (node?: EnvironmentNode | { kind: 'environment'; storeId?: string; environmentId: string }) => {
    if (!node || node.kind !== 'environment') return;
    if (node.environmentId === GLOBALS_ID || !node.storeId) await EnvironmentPanel.open(host, { environmentId: GLOBALS_ID });
    else await EnvironmentPanel.open(host, { storeId: node.storeId, environmentId: node.environmentId });
  });

  reg('reqvyn.globals.open', () => EnvironmentPanel.open(host, { environmentId: GLOBALS_ID }));

  reg('reqvyn.environment.new', async (node?: EnvironmentNode) => {
    const entry = node?.kind === 'store' || node?.kind === 'environment' ? stores.get(node.storeId) : await pickStore(stores, 'Create the environment in');
    if (!entry) return;
    const name = await vscode.window.showInputBox({ title: 'New environment', placeHolder: 'e.g. Development' });
    if (!name) return;
    const env = createEnvironment({ name });
    await entry.store.saveEnvironment(env);
    d.trees.environments.refresh();
    await EnvironmentPanel.open(host, { storeId: entry.id, environmentId: env.id });
  });

  reg('reqvyn.environment.duplicate', async (node?: EnvironmentNode) => {
    if (node?.kind !== 'environment') return;
    const entry = stores.get(node.storeId);
    const env = (await stores.environments(node.storeId)).find((e) => e.id === node.environmentId);
    if (!env) return;
    const copy: Environment = { ...env, id: newId(), name: `${env.name} (copy)` };
    // Secret values are copied vault-to-vault; they never pass through the file.
    for (const v of env.variables.filter((x) => x.secret)) {
      const val = await vault.get(secretKeys.environmentVariable(env.id, v.key));
      if (val !== undefined) await vault.set(secretKeys.environmentVariable(copy.id, v.key), val);
    }
    await entry.store.saveEnvironment(copy);
    d.trees.environments.refresh();
  });

  reg('reqvyn.environment.delete', async (node?: EnvironmentNode) => {
    if (node?.kind !== 'environment') return;
    const ok = await vscode.window.showWarningMessage(`Delete environment "${node.name}" and its stored secrets?`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    const entry = stores.get(node.storeId);
    const env = (await stores.environments(node.storeId)).find((e) => e.id === node.environmentId);
    for (const v of env?.variables ?? []) if (v.secret) await vault.delete(secretKeys.environmentVariable(node.environmentId, v.key));
    await entry.store.deleteEnvironment(node.environmentId);
    if (state.activeEnvironmentId(node.storeId) === node.environmentId) await state.setActiveEnvironment(node.storeId, null);
    EnvironmentPanel.closeFor(node.storeId, node.environmentId);
    d.trees.environments.refresh();
  });

  reg('reqvyn.clearRuntime', async () => {
    state.clearRuntime();
    state.cookieJar.clear();
    await RequestPanel.refreshVariables();
    vscode.window.setStatusBarMessage('REQVYN: runtime variables and cookies cleared', 3000);
  });

  // --- history -------------------------------------------------------------------------------

  reg('reqvyn.history.open', async (h?: HistoryEntry) => {
    if (!h) return;
    const parsed = HttpRequestSchema.safeParse(h.request);
    if (!parsed.success) throw new Error('This history entry cannot be opened (unknown format).');
    // History holds a sanitized snapshot; it opens as a new, unsaved request.
    await RequestPanel.openScratch(host, { ...parsed.data, name: parsed.data.name || `${h.method} ${h.url}` });
  });
  reg('reqvyn.history.delete', async (h?: HistoryEntry) => {
    if (h) await state.deleteHistory(h.id);
  });
  reg('reqvyn.history.clear', async () => {
    const ok = await vscode.window.showWarningMessage('Clear the request history?', { modal: true }, 'Clear');
    if (ok === 'Clear') await state.clearHistory();
  });

  // --- import --------------------------------------------------------------------------------

  reg('reqvyn.import', async () => {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      title: 'Import collections',
      openLabel: 'Import',
      filters: { 'Collections & specs': ['json', 'yaml', 'yml', 'reqvyn', 'zip', 'bru', 'txt', 'sh', 'curl'], 'All files': ['*'] },
    });
    if (!uris?.length) return;
    const files = [];
    for (const u of uris) {
      const bytes = await fs.readFile(u.fsPath);
      const binary = [PACKAGE_EXTENSION, '.zip'].includes(extname(u.fsPath).toLowerCase());
      files.push({ name: basename(u.fsPath), content: binary ? new Uint8Array(bytes) : bytes.toString('utf8') });
    }
    const result = importFiles(files);
    await importResult(result, uris.length === 1 ? uris[0]!.fsPath : undefined);
  });

  reg('reqvyn.importClipboard', async () => {
    const text = await vscode.env.clipboard.readText();
    if (!text.trim()) {
      void vscode.window.showInformationMessage('The clipboard is empty.');
      return;
    }
    const content = parseClipboard(text);
    if (content.error) throw new Error(content.error);
    if (content.kind === 'request' && content.request) {
      if (content.secrets.length) void vscode.window.showWarningMessage(`The pasted request contains ${content.secrets.length} credential(s). Save it to move them to secure storage.`);
      await RequestPanel.openScratch(host, { ...content.request, id: newId() });
      return;
    }
    await importResult({ collections: content.collections, environments: content.environments, warnings: content.warnings });
  });

  const importResult = async (result: ImportResult, sourcePath?: string) => {
    if (!result.collections.length && !result.environments.length) {
      throw new Error(result.warnings.map((w) => w.message).join('; ') || 'Nothing to import.');
    }
    const entry = await pickStore(stores, 'Import into');
    if (!entry) return;
    const existing = await Promise.all((await entry.store.listCollections()).map((s) => entry.store.loadCollection(s.id).catch(() => undefined)));
    const existingEnvs = await entry.store.listEnvironments();
    const preview = previewImport(result, { collections: existing.filter((c): c is Collection => !!c), environments: existingEnvs });
    const lines = [preview.summary];
    if (preview.secrets.length) lines.push(`\n${preview.secrets.length} credential(s) found – they will be moved to VS Code secure storage, not written to files.`);
    if (result.warnings.length) lines.push(`\n${result.warnings.length} warning(s) – see the REQVYN output channel.`);
    const ok = await vscode.window.showInformationMessage('Import', { modal: true, detail: lines.join('\n') }, 'Import');
    if (ok !== 'Import') return;
    for (const w of result.warnings) host.services.log.warn(`[import] ${w.location ? `${w.location}: ` : ''}${w.message}`);

    let movedSecrets = 0;
    for (const [i, imported] of result.collections.entries()) {
      const p = preview.collections[i]!;
      let toSave: Collection = imported;
      if (sourcePath && imported.meta.source && !imported.meta.source.location) toSave = { ...imported, meta: { ...imported.meta, source: { ...imported.meta.source, location: sourcePath } } };
      if (p.conflict !== 'none' && p.existingId) {
        const target = existing.find((c) => c?.id === p.existingId)!;
        const choice = await vscode.window.showQuickPick(
          [
            { label: 'Import as a separate copy', strategy: 'copy' as const },
            { label: `Merge into "${target.name}" – keep both`, strategy: 'keep-both' as MergeStrategy },
            { label: `Merge into "${target.name}" – overwrite matching requests`, strategy: 'overwrite' as MergeStrategy },
            { label: `Merge into "${target.name}" – skip matching requests`, strategy: 'skip' as MergeStrategy },
          ],
          { title: `"${imported.name}" already exists`, ignoreFocusOut: true },
        );
        if (!choice) continue;
        if (choice.strategy === 'copy') toSave = remapIds(toSave).collection;
        else toSave = mergeCollections(target, toSave, { strategy: choice.strategy }).collection;
      }
      const { collection, moved } = await vaultCollectionSecrets(toSave, vault);
      movedSecrets += moved;
      await entry.store.saveCollection(collection, { force: true });
    }
    for (const env of result.environments) {
      const clash = existingEnvs.find((e) => e.id === env.id);
      const toSave = clash ? { ...env, id: newId(), name: existingEnvs.some((e) => e.name === env.name) ? `${env.name} (imported)` : env.name } : env;
      movedSecrets += await vaultEnvironmentSecrets(toSave, vault);
      await entry.store.saveEnvironment(toSave);
    }
    refreshCollections();
    d.trees.environments.refresh();
    void vscode.window.showInformationMessage(`Imported ${result.collections.length} collection(s) and ${result.environments.length} environment(s)${movedSecrets ? `; ${movedSecrets} secret(s) moved to secure storage` : ''}.`);
  };

  reg('reqvyn.openapi.refresh', async (node?: CollectionNode) => {
    const n = selected(node, ['collection']);
    if (!n) return;
    const { store } = stores.get(n.storeId);
    const c = await store.loadCollection(n.collectionId);
    let file = c.meta.source?.location;
    const exists = file ? await fs.stat(file).then((s) => s.isFile(), () => false) : false;
    if (!exists) {
      const picked = await vscode.window.showOpenDialog({ title: 'OpenAPI document', filters: { OpenAPI: ['json', 'yaml', 'yml'] } });
      file = picked?.[0]?.fsPath;
    }
    if (!file) return;
    const plan = planOpenApiRefresh(c, await fs.readFile(file, 'utf8'), { fileName: basename(file) });
    if (!plan.added.length && !plan.changed.length && !plan.removed.length) {
      void vscode.window.showInformationMessage('The collection is up to date with the OpenAPI document.');
      return;
    }
    const choice = await vscode.window.showInformationMessage('Refresh from OpenAPI', { modal: true, detail: plan.preview }, 'Apply', 'Apply and remove missing');
    if (!choice) return;
    const res = applyOpenApiRefresh(c, plan, { removeMissing: choice === 'Apply and remove missing' });
    const next = { ...res.collection, meta: { ...res.collection.meta, source: { ...(res.collection.meta.source ?? { type: 'openapi' as const }), location: file } } };
    await store.saveCollection(next, { force: true });
    RequestPanel.closeFor(n.storeId, c.id, res.removed);
    await RequestPanel.reloadFromStore(n.storeId, c.id);
    refreshCollections();
    void vscode.window.showInformationMessage(`OpenAPI refresh: ${res.added.length} added, ${res.updated.length} updated, ${res.removed.length} removed, ${res.kept.length} kept.`);
  });

  // --- export & share ------------------------------------------------------------------------

  reg('reqvyn.export', async (node?: CollectionNode) => {
    const n = selected(node, ['collection']) ?? (await pickCollection(stores));
    if (!n) return;
    const entry = stores.get(n.storeId);
    const c = await entry.store.loadCollection(n.collectionId);
    const format = await vscode.window.showQuickPick(
      [
        { label: 'REQVYN JSON', ext: 'json', id: 'native' },
        { label: 'REQVYN package (ZIP)', description: 'collection + environments, for sharing', ext: PACKAGE_EXTENSION.slice(1), id: 'package' },
        { label: 'Postman Collection v2.1', ext: 'json', id: 'postman' },
        { label: 'OpenAPI 3 (JSON)', ext: 'json', id: 'openapi' },
        { label: 'OpenAPI 3 (YAML)', ext: 'yaml', id: 'openapi-yaml' },
        { label: 'cURL script', ext: 'sh', id: 'curl' },
      ],
      { title: `Export "${c.name}"`, placeHolder: 'Secrets are never included' },
    );
    if (!format) return;
    await exportTo(entry, c, format.id, format.ext);
  });

  reg('reqvyn.share', async (node?: CollectionNode) => {
    const n = selected(node, ['collection']) ?? (await pickCollection(stores));
    if (!n) return;
    const entry = stores.get(n.storeId);
    await exportTo(entry, await entry.store.loadCollection(n.collectionId), 'package', PACKAGE_EXTENSION.slice(1));
  });

  const exportTo = async (entry: StoreEntry, c: Collection, id: string, ext: string) => {
    const environments = await entry.store.listEnvironments();
    let data: string | Uint8Array;
    let removed = 0;
    let warnings: Array<{ message: string }> = [];
    switch (id) {
      case 'native': {
        const r = exportNative(c, { environments });
        data = r.text;
        removed = r.removed.length;
        warnings = r.warnings;
        break;
      }
      case 'package': {
        let envs = environments;
        if (environments.length) {
          const pick = await vscode.window.showQuickPick(
            environments.map((e) => ({ label: e.name, picked: true, env: e })),
            { canPickMany: true, title: 'Include environments (secret values are never included)' },
          );
          if (!pick) return;
          envs = pick.map((p) => p.env);
        }
        const r = buildPackage(c, { environments: envs, generator: `REQVYN VS Code ${context.extension.packageJSON.version as string}` });
        data = r.bytes;
        removed = r.removed.length;
        break;
      }
      case 'postman': {
        const r = exportPostman(c);
        data = r.text;
        removed = r.removed.length;
        warnings = r.warnings;
        break;
      }
      case 'openapi':
      case 'openapi-yaml': {
        const r = exportOpenApi(c, { format: id === 'openapi' ? 'json' : 'yaml', environments });
        data = r.text;
        warnings = r.warnings;
        break;
      }
      default: {
        const r = exportCurlScript(c);
        data = r.text;
        warnings = r.warnings;
      }
    }
    const safe = c.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'collection';
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(join(entry.baseDir, `${safe}.${ext}`)), filters: { Export: [ext] } });
    if (!uri) return;
    await fs.writeFile(uri.fsPath, data);
    for (const w of warnings) host.services.log.warn(`[export] ${w.message}`);
    const info = [`Exported to ${uri.fsPath}.`];
    if (removed) info.push(`${removed} sensitive value(s) were blanked.`);
    if (warnings.length) info.push(`${warnings.length} warning(s) in the output channel.`);
    const action = await vscode.window.showInformationMessage(info.join(' '), 'Reveal');
    if (action) await vscode.commands.executeCommand('revealFileInOS', uri);
  };

  // --- sync ----------------------------------------------------------------------------------

  const sync = d.sync;
  const instanceOf = (n?: SyncNode) => (n && n.kind !== 'untrusted' ? n.instanceId : undefined);
  reg('reqvyn.sync.add', () => sync.addInstance());
  reg('reqvyn.sync.edit', (n?: SyncNode) => instanceOf(n) && sync.editInstance(instanceOf(n)!));
  reg('reqvyn.sync.remove', (n?: SyncNode) => instanceOf(n) && sync.removeInstance(instanceOf(n)!));
  reg('reqvyn.sync.assign', async (n?: SyncNode | CollectionNode) => {
    if (n && (n.kind === 'collection')) await sync.assign(undefined, { storeId: n.storeId, collectionId: n.collectionId });
    else await sync.assign(n && (n.kind === 'instance' || n.kind === 'assignment') ? n.instanceId : undefined);
  });
  reg('reqvyn.sync.unassign', (n?: SyncNode) => n?.kind === 'assignment' && sync.unassign(n.instanceId, n));
  reg('reqvyn.sync.now', (n?: SyncNode) => (n?.kind === 'assignment' ? sync.sync(n.instanceId, n) : n?.kind === 'instance' ? sync.sync(n.instanceId) : sync.syncAll()));
  reg('reqvyn.sync.pull', (n?: SyncNode) => n?.kind === 'assignment' && sync.sync(n.instanceId, n, 'pull'));
  reg('reqvyn.sync.push', (n?: SyncNode) => n?.kind === 'assignment' && sync.sync(n.instanceId, n, 'push'));
  reg('reqvyn.sync.resolve', (n?: SyncNode) => n?.kind === 'assignment' && sync.resolve(n.instanceId, n));
  reg('reqvyn.sync.pullRemote', (n?: SyncNode) => sync.pullRemote(instanceOf(n)));
  reg('reqvyn.sync.all', () => sync.syncAll());
}

async function nodeLabel(stores: StoreManager, n: CollectionNode): Promise<string> {
  if (n.kind === 'store' || n.kind === 'problem') return '';
  const c = await stores.loadCollection(n.storeId, n.collectionId);
  if (n.kind === 'collection') return `collection "${c.name}" with ${c.requests.length} request(s)`;
  if (n.kind === 'folder') return `folder "${c.folders.find((f) => f.id === n.folderId)?.name}" and its contents`;
  return `request "${c.requests.find((r) => r.id === n.requestId)?.name}"`;
}

async function pickContainer(stores: StoreManager): Promise<ContainerNode | undefined> {
  const t = await pickCollectionTarget(stores, { title: 'Select a collection or folder', allowFolder: true });
  if (!t) return undefined;
  return t.folderId ? { kind: 'folder', storeId: t.entry.id, collectionId: t.collection.id, folderId: t.folderId } : { kind: 'collection', storeId: t.entry.id, collectionId: t.collection.id };
}

async function pickCollection(stores: StoreManager): Promise<Extract<CollectionNode, { kind: 'collection' }> | undefined> {
  const all = await stores.allCollections();
  const pick = await vscode.window.showQuickPick(
    all.map(({ entry, collection }) => ({ label: collection.name, description: entry.label, node: { kind: 'collection' as const, storeId: entry.id, collectionId: collection.id } })),
    { title: 'Select a collection' },
  );
  return pick?.node;
}

export type { HttpRequest };
