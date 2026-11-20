import * as vscode from 'vscode';
import { buildTree, type Collection, type HistoryEntry, type TreeNode } from '@reqvyn/core';
import { moveNode, moveToCollection, normalizeSortKeys, persistMutation } from '@reqvyn/collection-engine';
import type { StoreEntry, StoreManager } from './stores.js';
import { GLOBALS_ID, type AppState, type FavoriteRef } from './state.js';

// ---------------------------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------------------------

export type CollectionNode =
  | { kind: 'store'; storeId: string }
  | { kind: 'collection'; storeId: string; collectionId: string }
  | { kind: 'folder'; storeId: string; collectionId: string; folderId: string }
  | { kind: 'request'; storeId: string; collectionId: string; requestId: string }
  | { kind: 'problem'; storeId: string; message: string; file: string };

const METHOD_COLORS: Record<string, string> = {
  GET: 'charts.green',
  POST: 'charts.yellow',
  PUT: 'charts.blue',
  PATCH: 'charts.purple',
  DELETE: 'charts.red',
};

export function methodIcon(method: string): vscode.ThemeIcon {
  const color = METHOD_COLORS[method.toUpperCase()];
  return new vscode.ThemeIcon('symbol-method', color ? new vscode.ThemeColor(color) : undefined);
}

const MIME = 'application/vnd.code.tree.reqvyn.collections';

export class CollectionsTree implements vscode.TreeDataProvider<CollectionNode>, vscode.TreeDragAndDropController<CollectionNode>, vscode.Disposable {
  readonly dropMimeTypes = [MIME];
  readonly dragMimeTypes = [MIME];
  private readonly emitter = new vscode.EventEmitter<CollectionNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** Collections loaded for the current tree generation. */
  private cache = new Map<string, Collection>();
  private filter = '';

  constructor(
    private readonly stores: StoreManager,
    private readonly state: AppState,
  ) {}

  refresh(): void {
    this.cache.clear();
    this.emitter.fire(undefined);
  }

  setFilter(text: string): void {
    this.filter = text.trim().toLowerCase();
    void vscode.commands.executeCommand('setContext', 'reqvyn.collectionsFiltered', !!this.filter);
    this.refresh();
  }

  private async collection(storeId: string, id: string): Promise<Collection> {
    const k = `${storeId}|${id}`;
    let c = this.cache.get(k);
    if (!c) {
      c = await this.stores.loadCollection(storeId, id);
      this.cache.set(k, c);
    }
    return c;
  }

  async getChildren(node?: CollectionNode): Promise<CollectionNode[]> {
    if (!node) {
      const stores = this.stores.list();
      // A single store is shown flat; several stores get a group node each.
      if (stores.length === 1) return this.storeChildren(stores[0]!);
      return stores.map((s) => ({ kind: 'store', storeId: s.id }));
    }
    if (node.kind === 'store') return this.storeChildren(this.stores.get(node.storeId));
    if (node.kind === 'collection' || node.kind === 'folder') {
      const c = await this.collection(node.storeId, node.collectionId);
      const nodes = this.filteredTree(c);
      const parent = node.kind === 'folder' ? findNode(nodes, node.folderId)?.children ?? [] : nodes;
      return parent.map((n) =>
        n.kind === 'folder'
          ? { kind: 'folder', storeId: node.storeId, collectionId: c.id, folderId: n.id }
          : { kind: 'request', storeId: node.storeId, collectionId: c.id, requestId: n.id },
      );
    }
    return [];
  }

  private filteredTree(c: Collection): TreeNode[] {
    const tree = buildTree(c);
    if (!this.filter) return tree;
    const reqs = new Map(c.requests.map((r) => [r.id, r]));
    const keep = (n: TreeNode): TreeNode | undefined => {
      if (n.kind === 'request') {
        const r = reqs.get(n.id);
        return r && `${r.name} ${r.method} ${r.url}`.toLowerCase().includes(this.filter) ? n : undefined;
      }
      const children = n.children.map(keep).filter((x): x is TreeNode => !!x);
      return children.length || n.name.toLowerCase().includes(this.filter) ? { ...n, children } : undefined;
    };
    return tree.map(keep).filter((x): x is TreeNode => !!x);
  }

  private async storeChildren(entry: StoreEntry): Promise<CollectionNode[]> {
    const out: CollectionNode[] = [];
    const summaries = await entry.store.listCollections();
    const order = (await entry.store.loadConfig().catch(() => undefined))?.collectionOrder ?? [];
    summaries.sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      if (ia !== ib) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
      return a.name.localeCompare(b.name);
    });
    for (const s of summaries) {
      if (this.filter) {
        const c = await this.collection(entry.id, s.id);
        if (!c.name.toLowerCase().includes(this.filter) && !this.filteredTree(c).length) continue;
      }
      out.push({ kind: 'collection', storeId: entry.id, collectionId: s.id });
    }
    for (const p of entry.store.getProblems()) out.push({ kind: 'problem', storeId: entry.id, message: p.message, file: p.file });
    return out;
  }

  async getTreeItem(node: CollectionNode): Promise<vscode.TreeItem> {
    const expanded = this.filter ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    switch (node.kind) {
      case 'store': {
        const e = this.stores.get(node.storeId);
        const item = new vscode.TreeItem(e.label, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(e.kind === 'workspace' ? 'repo' : 'account');
        item.tooltip = e.kind === 'workspace' ? `Stored in ${e.store.root} (commit it to share with your team)` : 'Stored only on this machine';
        item.contextValue = 'store';
        item.id = `store:${node.storeId}`;
        return item;
      }
      case 'collection': {
        const c = await this.collection(node.storeId, node.collectionId);
        const item = new vscode.TreeItem(c.name, expanded);
        item.iconPath = new vscode.ThemeIcon('folder-library');
        item.description = `${c.requests.length}`;
        item.tooltip = c.description || c.name;
        item.contextValue = c.meta.source?.type === 'openapi' ? 'collection openapi' : 'collection';
        item.id = `c:${node.storeId}|${c.id}`;
        return item;
      }
      case 'folder': {
        const c = await this.collection(node.storeId, node.collectionId);
        const f = c.folders.find((x) => x.id === node.folderId);
        const item = new vscode.TreeItem(f?.name ?? '?', expanded);
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = 'folder';
        item.id = `f:${node.storeId}|${node.folderId}`;
        return item;
      }
      case 'request': {
        const c = await this.collection(node.storeId, node.collectionId);
        const r = c.requests.find((x) => x.id === node.requestId);
        const item = new vscode.TreeItem(r?.name ?? '?', vscode.TreeItemCollapsibleState.None);
        item.description = r?.method;
        item.iconPath = methodIcon(r?.method ?? 'GET');
        item.tooltip = r ? `${r.method} ${r.url}` : undefined;
        item.contextValue = this.state.isFavorite(node.requestId) ? 'request favorite' : 'request';
        item.command = { command: 'reqvyn.openRequest', title: 'Open', arguments: [node] };
        item.id = `r:${node.storeId}|${node.requestId}`;
        return item;
      }
      case 'problem': {
        const item = new vscode.TreeItem(`Unreadable file: ${node.file.split(/[\\/]/).pop()}`, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        item.tooltip = `${node.file}\n${node.message}`;
        item.command = { command: 'vscode.open', title: 'Open file', arguments: [vscode.Uri.file(node.file)] };
        return item;
      }
    }
  }

  async getParent(node: CollectionNode): Promise<CollectionNode | undefined> {
    if (node.kind === 'store' || node.kind === 'problem') return undefined;
    if (node.kind === 'collection') return this.stores.list().length > 1 ? { kind: 'store', storeId: node.storeId } : undefined;
    const c = await this.collection(node.storeId, node.collectionId);
    const parentId = node.kind === 'folder' ? c.folders.find((f) => f.id === node.folderId)?.parentId : c.requests.find((r) => r.id === node.requestId)?.parentId;
    return parentId ? { kind: 'folder', storeId: node.storeId, collectionId: c.id, folderId: parentId } : { kind: 'collection', storeId: node.storeId, collectionId: c.id };
  }

  // --- drag and drop -------------------------------------------------------------------------

  handleDrag(source: readonly CollectionNode[], data: vscode.DataTransfer): void {
    const movable = source.filter((n) => n.kind === 'folder' || n.kind === 'request');
    if (movable.length) data.set(MIME, new vscode.DataTransferItem(movable));
  }

  async handleDrop(target: CollectionNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const item = data.get(MIME);
    if (!item || !target || target.kind === 'store' || target.kind === 'problem') return;
    const nodes = item.value as CollectionNode[];
    // Drop on a request: insert before it, in its parent.
    let parentId: string | null = null;
    let beforeId: string | null = null;
    let targetCollection = '';
    const tc = await this.collection(target.storeId, target.collectionId);
    targetCollection = tc.id;
    if (target.kind === 'folder') parentId = target.folderId;
    if (target.kind === 'request') {
      parentId = tc.requests.find((r) => r.id === target.requestId)?.parentId ?? null;
      beforeId = target.requestId;
    }
    try {
      for (const n of nodes) {
        if (n.kind !== 'folder' && n.kind !== 'request') continue;
        const id = n.kind === 'folder' ? n.folderId : n.requestId;
        if (n.kind === 'folder' && id === parentId) continue;
        const store = this.stores.get(n.storeId).store;
        if (n.storeId === target.storeId && n.collectionId === targetCollection) {
          const c = await store.loadCollection(targetCollection);
          const m = moveNode(c, id, parentId, beforeId);
          await persistMutation(store, m);
          const norm = normalizeSortKeys(m.collection, parentId);
          await persistMutation(store, { collection: norm.collection, changedFolders: norm.changed.folders, changedRequests: norm.changed.requests, removedFolders: [], removedRequests: [] });
        } else {
          // Move across collections (and stores): write the target first, then remove from the source.
          const source = await store.loadCollection(n.collectionId);
          const targetStore = this.stores.get(target.storeId).store;
          const dest = await targetStore.loadCollection(targetCollection);
          const moved = moveToCollection(source, dest, id, parentId);
          await targetStore.saveCollection(moved.target);
          await store.saveCollection(moved.source);
        }
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`REQVYN: move failed – ${e instanceof Error ? e.message : String(e)}`);
    }
    this.refresh();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function findNode(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.kind === 'folder') {
      const f = findNode(n.children, id);
      if (f) return f;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

export class HistoryTree implements vscode.TreeDataProvider<HistoryEntry> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly state: AppState) {}

  refresh(): void {
    this.emitter.fire();
  }

  async getChildren(node?: HistoryEntry): Promise<HistoryEntry[]> {
    return node ? [] : this.state.loadHistory();
  }

  getTreeItem(h: HistoryEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(`${h.method} ${shortUrl(h.url)}`, vscode.TreeItemCollapsibleState.None);
    const when = new Date(h.timestamp);
    item.description = `${h.status ?? 'ERR'} · ${h.durationMs ?? 0} ms · ${relativeTime(when)}`;
    item.tooltip = new vscode.MarkdownString(`**${h.method}** ${escapeMd(h.url)}\n\nStatus: ${h.status ?? 'error'}  \nTime: ${h.durationMs ?? 0} ms  \nSize: ${h.size ?? 0} B  \n${when.toLocaleString()}`);
    item.iconPath = h.status === undefined ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')) : methodIcon(h.method);
    item.contextValue = 'history';
    item.command = { command: 'reqvyn.history.open', title: 'Open', arguments: [h] };
    return item;
  }
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').slice(0, 80);
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

export function relativeTime(d: Date, now = Date.now()): string {
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return d.toLocaleDateString();
}

// ---------------------------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------------------------

export type EnvironmentNode = { kind: 'globals' } | { kind: 'store'; storeId: string } | { kind: 'environment'; storeId: string; environmentId: string; name: string };

export class EnvironmentsTree implements vscode.TreeDataProvider<EnvironmentNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly stores: StoreManager,
    private readonly state: AppState,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  async getChildren(node?: EnvironmentNode): Promise<EnvironmentNode[]> {
    if (!node) {
      const stores = this.stores.list();
      const head: EnvironmentNode[] = [{ kind: 'globals' }];
      if (stores.length === 1) return [...head, ...(await this.envs(stores[0]!.id))];
      return [...head, ...stores.map((s) => ({ kind: 'store' as const, storeId: s.id }))];
    }
    if (node.kind === 'store') return this.envs(node.storeId);
    return [];
  }

  private async envs(storeId: string): Promise<EnvironmentNode[]> {
    const list = await this.stores.environments(storeId);
    return list.sort((a, b) => a.name.localeCompare(b.name)).map((e) => ({ kind: 'environment', storeId, environmentId: e.id, name: e.name }));
  }

  getTreeItem(node: EnvironmentNode): vscode.TreeItem {
    if (node.kind === 'globals') {
      const item = new vscode.TreeItem('Global Variables', vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('globe');
      item.contextValue = 'globals';
      item.command = { command: 'reqvyn.environment.open', title: 'Open', arguments: [{ kind: 'environment', environmentId: GLOBALS_ID, name: 'Globals' }] };
      return item;
    }
    if (node.kind === 'store') {
      const item = new vscode.TreeItem(this.stores.get(node.storeId).label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('repo');
      return item;
    }
    const active = this.state.activeEnvironmentId(node.storeId) === node.environmentId;
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(active ? 'pass-filled' : 'circle-large-outline', active ? new vscode.ThemeColor('charts.green') : undefined);
    item.description = active ? 'active' : undefined;
    item.contextValue = active ? 'environment active' : 'environment';
    item.command = { command: 'reqvyn.environment.open', title: 'Open', arguments: [node] };
    item.accessibilityInformation = { label: `${node.name}${active ? ', active environment' : ''}` };
    return item;
  }
}

// ---------------------------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------------------------

export class FavoritesTree implements vscode.TreeDataProvider<FavoriteRef> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly state: AppState) {}

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(node?: FavoriteRef): FavoriteRef[] {
    return node ? [] : this.state.favorites();
  }

  getTreeItem(f: FavoriteRef): vscode.TreeItem {
    const item = new vscode.TreeItem(f.name, vscode.TreeItemCollapsibleState.None);
    item.description = f.method;
    item.iconPath = methodIcon(f.method);
    item.contextValue = 'favorite';
    item.command = { command: 'reqvyn.openRequest', title: 'Open', arguments: [{ kind: 'request', storeId: f.storeId, collectionId: f.collectionId, requestId: f.requestId }] };
    return item;
  }
}
