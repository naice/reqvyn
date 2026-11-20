import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FileSyncStateStore, SyncEngine, SyncProviderRegistry, collectionStoreAccess, type ConflictDecision, type GuardedSyncProvider, type SyncConflict, type SyncMode, type SyncRunResult, type SyncState } from '@reqvyn/sync-core';
import type { SyncConfigField, SyncConfigValue, SyncProviderDescriptor } from '@reqvyn/provider-sdk';
import { errorMessage } from '@reqvyn/shared';
import type { SecretVault } from '@reqvyn/core';
import type { StoreManager } from './stores.js';
import type { ResponseDocuments } from './responses.js';
import type { Log } from './services.js';

export interface SyncAssignment {
  storeId: string;
  collectionId: string;
}

export interface SyncInstanceConfig {
  instanceId: string;
  providerId: string;
  label: string;
  /** Non-secret configuration. Secret fields live in SecretStorage (scoped per instance). */
  config: Record<string, SyncConfigValue>;
  collections: SyncAssignment[];
}

const INSTANCES_KEY = 'reqvyn.sync.instances';

export type SyncNode = { kind: 'instance'; instanceId: string } | { kind: 'assignment'; instanceId: string; storeId: string; collectionId: string } | { kind: 'untrusted' };

/**
 * Host side of the sync SDK: provider registry, configured instances, collection assignment and
 * runs. Sync is disabled in untrusted workspaces (providers can execute git, touch the file system
 * and use credentials).
 */
export class SyncManager implements vscode.TreeDataProvider<SyncNode>, vscode.Disposable {
  readonly registry: SyncProviderRegistry;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly stateStore: FileSyncStateStore;
  private readonly running = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly stores: StoreManager,
    vault: SecretVault,
    private readonly responses: ResponseDocuments,
    private readonly log: Log,
    private readonly onCollectionChanged: (storeId: string, collectionId: string) => Promise<void>,
  ) {
    this.registry = new SyncProviderRegistry({
      vault,
      logger: {
        debug: () => undefined,
        info: (m) => log.info(`[sync] ${m}`),
        warn: (m) => log.warn(`[sync] ${m}`),
        error: (m) => log.error(`[sync] ${m}`),
      },
    });
    this.stateStore = new FileSyncStateStore(join(context.globalStorageUri.fsPath, 'sync-state'));
    const sub = this.registry.onDidChange(() => this.refresh());
    this.disposables.push({ dispose: () => sub.dispose() }, vscode.workspace.onDidGrantWorkspaceTrust(() => this.refresh()));
  }

  refresh(): void {
    this.emitter.fire();
  }

  instances(): SyncInstanceConfig[] {
    return this.context.globalState.get<SyncInstanceConfig[]>(INSTANCES_KEY, []);
  }

  private async saveInstances(list: SyncInstanceConfig[]): Promise<void> {
    await this.context.globalState.update(INSTANCES_KEY, list);
    this.refresh();
  }

  private instance(id: string): SyncInstanceConfig {
    const i = this.instances().find((x) => x.instanceId === id);
    if (!i) throw new Error('This sync provider configuration no longer exists.');
    return i;
  }

  private ensureTrusted(): boolean {
    if (vscode.workspace.isTrusted) return true;
    void vscode.window.showWarningMessage('REQVYN: Sync is disabled in untrusted workspaces.');
    return false;
  }

  // --- configuration -------------------------------------------------------------------------

  async addInstance(): Promise<void> {
    if (!this.ensureTrusted()) return;
    const providers = this.registry.list();
    if (!providers.length) {
      void vscode.window.showInformationMessage('No sync providers are registered.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      providers.map((d) => ({ label: d.displayName, description: d.id, detail: d.description, descriptor: d })),
      { title: 'Add sync provider', placeHolder: 'Choose a provider type' },
    );
    if (!pick) return;
    const instanceId = randomUUID().replace(/-/g, '').slice(0, 16);
    const config = await this.promptConfig(pick.descriptor, instanceId, {});
    if (!config) {
      await this.registry.deleteInstanceSecrets(instanceId, pick.descriptor.id);
      return;
    }
    const label = await vscode.window.showInputBox({ title: 'Name for this sync configuration', value: pick.descriptor.displayName });
    if (label === undefined) {
      await this.registry.deleteInstanceSecrets(instanceId, pick.descriptor.id);
      return;
    }
    await this.saveInstances([...this.instances(), { instanceId, providerId: pick.descriptor.id, label: label || pick.descriptor.displayName, config, collections: [] }]);
    const assign = await vscode.window.showInformationMessage(`Sync provider "${label}" added.`, 'Assign collection');
    if (assign) await this.assign(instanceId);
  }

  async editInstance(instanceId: string): Promise<void> {
    if (!this.ensureTrusted()) return;
    const inst = this.instance(instanceId);
    const d = this.registry.get(inst.providerId);
    if (!d) throw new Error(`Provider ${inst.providerId} is not installed.`);
    const config = await this.promptConfig(d, instanceId, inst.config);
    if (!config) return;
    await this.saveInstances(this.instances().map((i) => (i.instanceId === instanceId ? { ...i, config } : i)));
  }

  /** Ask for every field. Secret fields go to the instance's secret scope, never to settings. */
  private async promptConfig(d: SyncProviderDescriptor, instanceId: string, current: Record<string, SyncConfigValue>): Promise<Record<string, SyncConfigValue> | undefined> {
    const out: Record<string, SyncConfigValue> = {};
    const secrets = this.registry.secretsFor(instanceId);
    for (const f of d.configSchema) {
      const title = `${d.displayName}: ${f.label}${f.required ? '' : ' (optional)'}`;
      if (f.type === 'secret') {
        const has = (await secrets.get(f.key)) !== undefined;
        const v = await vscode.window.showInputBox({ title, prompt: `${f.description ?? ''}${has ? ' Leave empty to keep the stored value.' : ''}`, password: true, ignoreFocusOut: true });
        if (v === undefined) return undefined;
        if (v) await secrets.set(f.key, v);
        continue;
      }
      const value = await promptField(f, title, current[f.key] ?? f.default);
      if (value === null) return undefined;
      if (value !== undefined && value !== '') out[f.key] = value;
    }
    const { issues } = await this.registry.validateInstanceConfig(d.id, instanceId, out);
    if (issues.length) {
      void vscode.window.showErrorMessage(`Invalid configuration: ${issues.map((i) => i.message).join('; ')}`);
      return undefined;
    }
    return out;
  }

  async removeInstance(instanceId: string): Promise<void> {
    const inst = this.instance(instanceId);
    const ok = await vscode.window.showWarningMessage(`Remove sync configuration "${inst.label}"? Local collections are kept; the remote is not touched.`, { modal: true }, 'Remove');
    if (ok !== 'Remove') return;
    for (const a of inst.collections) await this.stateStore.delete(instanceId, a.collectionId).catch(() => undefined);
    await this.registry.deleteInstanceSecrets(instanceId, inst.providerId);
    await this.saveInstances(this.instances().filter((i) => i.instanceId !== instanceId));
  }

  async assign(instanceId?: string, target?: SyncAssignment): Promise<void> {
    if (!this.ensureTrusted()) return;
    const id = instanceId ?? (await this.pickInstance());
    if (!id) return;
    const inst = this.instance(id);
    let ref = target;
    if (!ref) {
      const all = await this.stores.allCollections();
      const items = all
        .filter(({ entry, collection }) => !inst.collections.some((a) => a.storeId === entry.id && a.collectionId === collection.id))
        .map(({ entry, collection }) => ({ label: collection.name, description: entry.label, ref: { storeId: entry.id, collectionId: collection.id } }));
      if (!items.length) {
        void vscode.window.showInformationMessage('All collections are already assigned.');
        return;
      }
      ref = (await vscode.window.showQuickPick(items, { title: `Assign collection to ${inst.label}` }))?.ref;
      if (!ref) return;
    }
    if (inst.collections.some((a) => a.storeId === ref!.storeId && a.collectionId === ref!.collectionId)) return;
    await this.saveInstances(this.instances().map((i) => (i.instanceId === id ? { ...i, collections: [...i.collections, ref!] } : i)));
    const now = await vscode.window.showInformationMessage('Collection assigned.', 'Sync now');
    if (now) await this.sync(id, ref);
  }

  async unassign(instanceId: string, ref: SyncAssignment): Promise<void> {
    await this.stateStore.delete(instanceId, ref.collectionId).catch(() => undefined);
    await this.saveInstances(this.instances().map((i) => (i.instanceId === instanceId ? { ...i, collections: i.collections.filter((a) => !(a.storeId === ref.storeId && a.collectionId === ref.collectionId)) } : i)));
  }

  private async pickInstance(): Promise<string | undefined> {
    const list = this.instances();
    if (!list.length) {
      const add = await vscode.window.showInformationMessage('No sync provider is configured.', 'Add provider');
      if (add) await this.addInstance();
      return undefined;
    }
    if (list.length === 1) return list[0]!.instanceId;
    return (await vscode.window.showQuickPick(list.map((i) => ({ label: i.label, description: i.providerId, id: i.instanceId })), { title: 'Sync provider' }))?.id;
  }

  // --- running -------------------------------------------------------------------------------

  private async withProvider<T>(inst: SyncInstanceConfig, fn: (provider: GuardedSyncProvider) => Promise<T>): Promise<T> {
    const provider = await this.registry.createInstance({
      instanceId: inst.instanceId,
      providerId: inst.providerId,
      config: inst.config,
      storagePath: join(this.context.globalStorageUri.fsPath, 'sync', inst.instanceId),
    });
    try {
      return await fn(provider);
    } finally {
      await provider.dispose();
    }
  }

  private engine(provider: GuardedSyncProvider, inst: SyncInstanceConfig, storeId: string): SyncEngine {
    return new SyncEngine({ provider, instanceId: inst.instanceId, local: collectionStoreAccess(this.stores.get(storeId).store), stateStore: this.stateStore });
  }

  /** Sync one assignment (or all assignments of an instance). */
  async sync(instanceId: string, only?: SyncAssignment, mode: SyncMode = 'bidirectional', decisions?: Record<string, ConflictDecision>): Promise<SyncRunResult[]> {
    if (!this.ensureTrusted()) return [];
    const inst = this.instance(instanceId);
    const targets = only ? [only] : inst.collections;
    if (!targets.length) {
      void vscode.window.showInformationMessage('No collections are assigned to this provider.');
      return [];
    }
    if (this.running.has(instanceId)) {
      void vscode.window.showInformationMessage('A sync for this provider is already running.');
      return [];
    }
    this.running.add(instanceId);
    this.refresh();
    const results: SyncRunResult[] = [];
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `REQVYN sync: ${inst.label}`, cancellable: true }, async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        await this.withProvider(inst, async (provider) => {
          for (const t of targets) {
            if (!this.stores.tryGet(t.storeId)) {
              this.log.warn(`[sync] store ${t.storeId} is not open – skipped`);
              continue;
            }
            const engine = this.engine(provider, inst, t.storeId);
            const r = await engine.sync(t.collectionId, { mode, signal: abort.signal, decisions, onProgress: (p) => progress.report({ message: p.message ?? p.phase }) });
            results.push(r);
            if (r.appliedLocally) await this.onCollectionChanged(t.storeId, t.collectionId);
          }
        });
      });
    } catch (e) {
      void vscode.window.showErrorMessage(`REQVYN sync failed: ${errorMessage(e)}`);
      return results;
    } finally {
      this.running.delete(instanceId);
      this.refresh();
    }
    await this.report(inst, results);
    return results;
  }

  private async report(inst: SyncInstanceConfig, results: SyncRunResult[]): Promise<void> {
    const failed = results.filter((r) => r.status === 'failed');
    const conflicts = results.filter((r) => r.status === 'conflicts');
    for (const r of results) for (const w of r.warnings) this.log.warn(`[sync] ${r.collectionId}: ${w.message}`);
    if (failed.length) {
      void vscode.window.showErrorMessage(`Sync failed for ${failed.length} collection(s): ${failed.map((r) => r.error?.message ?? 'unknown error').join('; ')}`);
    }
    if (conflicts.length) {
      const n = conflicts.reduce((s, r) => s + r.conflicts.length, 0);
      const go = await vscode.window.showWarningMessage(`${n} sync conflict(s) need a decision. Nothing conflicting was overwritten.`, 'Resolve');
      if (go) {
        const first = inst.collections.find((a) => a.collectionId === conflicts[0]!.collectionId);
        if (first) await this.resolve(inst.instanceId, first);
      }
      return;
    }
    if (!failed.length && results.length) {
      const changed = results.reduce((s, r) => s + count(r.localChanges) + count(r.remoteChanges), 0);
      vscode.window.setStatusBarMessage(`REQVYN: ${inst.label} synced${changed ? ` (${changed} change(s))` : ' – up to date'}`, 5000);
    }
  }

  /** Walk through pending conflicts one by one; nothing is applied until all decisions are made. */
  async resolve(instanceId: string, ref: SyncAssignment): Promise<void> {
    const inst = this.instance(instanceId);
    const state = await this.stateStore.load(instanceId, ref.collectionId);
    const conflicts = state?.pendingConflicts ?? [];
    if (!conflicts.length) {
      void vscode.window.showInformationMessage('There are no pending conflicts.');
      return;
    }
    const decisions: Record<string, ConflictDecision> = {};
    for (const [i, c] of conflicts.entries()) {
      for (;;) {
        const choice = await vscode.window.showQuickPick(
          [
            { label: '$(arrow-up) Keep local', description: c.local ? '' : '(deleted locally)', value: 'local' as const },
            { label: '$(arrow-down) Take remote', description: c.remote ? '' : '(deleted remotely)', value: 'remote' as const },
            { label: '$(diff) Show differences', value: 'diff' as const },
          ],
          { title: `Conflict ${i + 1}/${conflicts.length}: ${describe(c)}`, placeHolder: c.fields?.length ? `Changed on both sides: ${c.fields.join(', ')}` : c.type, ignoreFocusOut: true },
        );
        if (!choice) return;
        if (choice.value === 'diff') {
          await this.showDiff(c);
          continue;
        }
        decisions[c.id] = choice.value;
        break;
      }
    }
    const results = await this.sync(inst.instanceId, ref, 'bidirectional', decisions);
    const stale = results.flatMap((r) => r.staleDecisions);
    if (stale.length) void vscode.window.showWarningMessage(`${stale.length} decision(s) were ignored because the conflict changed in the meantime. Sync again to review.`);
  }

  private async showDiff(c: SyncConflict): Promise<void> {
    const fmt = (e: SyncConflict['local']) => (e ? JSON.stringify(e.data, null, 2) : '// deleted');
    const left = this.responses.put(`remote-${c.id}`, 'json', fmt(c.remote));
    const right = this.responses.put(`local-${c.id}`, 'json', fmt(c.local));
    await vscode.commands.executeCommand('vscode.diff', left, right, `${describe(c)}: remote ↔ local`);
  }

  /** Pull a collection that exists only remotely into a local store. */
  async pullRemote(instanceId?: string): Promise<void> {
    if (!this.ensureTrusted()) return;
    const id = instanceId ?? (await this.pickInstance());
    if (!id) return;
    const inst = this.instance(id);
    const d = this.registry.get(inst.providerId);
    if (!d?.capabilities.list) {
      void vscode.window.showInformationMessage('This provider cannot list remote collections.');
      return;
    }
    const remote = await this.withProvider(inst, (p) => p.listRemoteCollections());
    const items = remote
      .filter((r) => !inst.collections.some((a) => a.collectionId === r.collectionId))
      .map((r) => ({ label: r.label ?? r.collectionId, description: r.updatedAt, id: r.collectionId }));
    if (!items.length) {
      void vscode.window.showInformationMessage('No unassigned remote collections found.');
      return;
    }
    const pick = await vscode.window.showQuickPick(items, { title: 'Pull remote collection' });
    if (!pick) return;
    const stores = this.stores.list();
    const store =
      stores.length === 1 ? stores[0] : (await vscode.window.showQuickPick(stores.map((s) => ({ label: s.label, entry: s })), { title: 'Store the collection in' }))?.entry;
    if (!store) return;
    const ref = { storeId: store.id, collectionId: pick.id };
    await this.saveInstances(this.instances().map((i) => (i.instanceId === id ? { ...i, collections: [...i.collections, ref] } : i)));
    await this.sync(id, ref, 'pull');
  }

  /** Run all assignments of all instances (command "Sync all"). */
  async syncAll(): Promise<void> {
    for (const i of this.instances()) if (i.collections.length) await this.sync(i.instanceId);
  }

  // --- tree ----------------------------------------------------------------------------------

  getChildren(node?: SyncNode): SyncNode[] {
    if (!vscode.workspace.isTrusted) return node ? [] : [{ kind: 'untrusted' }];
    if (!node) return this.instances().map((i) => ({ kind: 'instance', instanceId: i.instanceId }));
    if (node.kind === 'instance') {
      const inst = this.instances().find((i) => i.instanceId === node.instanceId);
      return inst?.collections.map((a) => ({ kind: 'assignment', instanceId: node.instanceId, ...a })) ?? [];
    }
    return [];
  }

  async getTreeItem(node: SyncNode): Promise<vscode.TreeItem> {
    if (node.kind === 'untrusted') {
      const item = new vscode.TreeItem('Sync is disabled in untrusted workspaces');
      item.iconPath = new vscode.ThemeIcon('workspace-untrusted');
      return item;
    }
    const inst = this.instances().find((i) => i.instanceId === node.instanceId);
    if (node.kind === 'instance') {
      const d = inst && this.registry.get(inst.providerId);
      const item = new vscode.TreeItem(inst?.label ?? '?', vscode.TreeItemCollapsibleState.Expanded);
      item.description = this.running.has(node.instanceId) ? 'syncing…' : d ? d.displayName : 'provider not installed';
      item.iconPath = new vscode.ThemeIcon(this.running.has(node.instanceId) ? 'sync~spin' : d ? 'cloud' : 'warning');
      item.contextValue = 'syncInstance';
      return item;
    }
    let name = node.collectionId;
    try {
      name = (await this.stores.loadCollection(node.storeId, node.collectionId)).name;
    } catch {
      name = `${node.collectionId} (not available locally yet)`;
    }
    const state: SyncState | null = await this.stateStore.load(node.instanceId, node.collectionId).catch(() => null);
    const item = new vscode.TreeItem(name);
    const conflicts = state?.pendingConflicts.length ?? 0;
    item.description = conflicts ? `${conflicts} conflict(s)` : state?.lastSyncAt ? `${state.lastStatus} · ${new Date(state.lastSyncAt).toLocaleString()}` : 'never synced';
    item.iconPath = new vscode.ThemeIcon(conflicts ? 'warning' : state?.lastStatus === 'failed' ? 'error' : 'folder-library');
    item.tooltip = state?.lastError ? `Last error: ${state.lastError.message}` : undefined;
    item.contextValue = conflicts ? 'syncAssignment conflicts' : 'syncAssignment';
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function count(c: { added: string[]; updated: string[]; deleted: string[] }): number {
  return c.added.length + c.updated.length + c.deleted.length;
}

function describe(c: SyncConflict): string {
  return `${c.kind} "${c.label ?? c.id}"`;
}

/** Returns `null` when cancelled, `undefined` for "no value". */
async function promptField(f: SyncConfigField, title: string, current: SyncConfigValue | undefined): Promise<SyncConfigValue | undefined | null> {
  if (f.type === 'boolean') {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Yes', v: true },
        { label: 'No', v: false },
      ],
      { title, placeHolder: f.description },
    );
    return pick ? pick.v : null;
  }
  if (f.type === 'path') {
    const how = await vscode.window.showQuickPick(
      [
        { label: '$(folder-opened) Browse…', v: 'browse' },
        { label: '$(edit) Type a path', v: 'type' },
        ...(f.required ? [] : [{ label: '$(close) Leave empty', v: 'empty' }]),
      ],
      { title, placeHolder: f.description ?? (current ? String(current) : undefined) },
    );
    if (!how) return null;
    if (how.v === 'empty') return undefined;
    if (how.v === 'browse') {
      const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title });
      return uri?.[0]?.fsPath ?? null;
    }
  }
  const v = await vscode.window.showInputBox({
    title,
    prompt: f.description,
    placeHolder: f.placeholder,
    value: current === undefined ? '' : String(current),
    ignoreFocusOut: true,
    validateInput: (s) => {
      if (f.required && !s.trim()) return 'Required';
      if (f.type === 'number' && s.trim() && !Number.isFinite(Number(s))) return 'Enter a number';
      if (f.type === 'url' && s.trim()) {
        try {
          new URL(s);
        } catch {
          return 'Enter a valid URL';
        }
      }
      return undefined;
    },
  });
  if (v === undefined) return null;
  if (f.type === 'number') return v.trim() ? Number(v) : undefined;
  return v.trim();
}
