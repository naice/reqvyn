import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FileSystemStore } from '@reqvyn/collection-engine';
import type { Collection, Environment, StoreChangeEvent } from '@reqvyn/core';
import { ReqvynError } from '@reqvyn/shared';

export const STORE_DIR = '.reqvyn';
export const PERSONAL_STORE_ID = 'personal';

export interface StoreEntry {
  id: string;
  label: string;
  kind: 'personal' | 'workspace';
  store: FileSystemStore;
  /** Base directory for relative paths (workspace folder, or the personal storage dir). */
  baseDir: string;
  folder?: vscode.WorkspaceFolder;
}

/**
 * Owns all collection stores: one personal store (global storage, not shared) and one store per
 * workspace folder that contains a `.reqvyn/` directory (committed and shared through Git).
 */
export class StoreManager implements vscode.Disposable {
  private readonly entries = new Map<string, StoreEntry>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<{ storeId: string; event: StoreChangeEvent }>();
  readonly onDidChange = this.emitter.event;
  private readonly structureEmitter = new vscode.EventEmitter<void>();
  /** Fired when stores are added/removed. */
  readonly onDidChangeStores = this.structureEmitter.event;

  constructor(private readonly globalStorage: vscode.Uri) {}

  async initialize(): Promise<void> {
    const personalDir = join(this.globalStorage.fsPath, 'personal');
    await this.add({ id: PERSONAL_STORE_ID, label: 'Personal', kind: 'personal', store: new FileSystemStore(personalDir, { id: PERSONAL_STORE_ID, label: 'Personal', kind: 'personal' }), baseDir: personalDir }, true);
    for (const folder of vscode.workspace.workspaceFolders ?? []) await this.openFolder(folder, false);

    const watcher = vscode.workspace.createFileSystemWatcher(`**/${STORE_DIR}/**/*.json`);
    const notify = (uri: vscode.Uri) => {
      for (const e of this.entries.values()) {
        if (e.kind === 'workspace' && uri.fsPath.startsWith(e.store.root)) void e.store.notifyFileChanged(uri.fsPath).catch(() => undefined);
      }
    };
    this.disposables.push(
      watcher,
      watcher.onDidChange(notify),
      watcher.onDidCreate(notify),
      watcher.onDidDelete(notify),
      vscode.workspace.onDidChangeWorkspaceFolders(async (ev) => {
        for (const f of ev.removed) this.remove(storeIdFor(f));
        for (const f of ev.added) await this.openFolder(f, false);
        this.structureEmitter.fire();
      }),
    );
  }

  private async add(entry: StoreEntry, create: boolean): Promise<void> {
    if (create) await entry.store.init();
    await entry.store.recover().catch(() => undefined);
    this.entries.set(entry.id, entry);
    this.disposables.push(entry.store.onDidChange((event) => this.emitter.fire({ storeId: entry.id, event })));
  }

  private remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.store.dispose();
    this.entries.delete(id);
  }

  /** Open the `.reqvyn` store of a workspace folder. With `create`, the directory is initialized. */
  async openFolder(folder: vscode.WorkspaceFolder, create: boolean): Promise<StoreEntry | undefined> {
    const id = storeIdFor(folder);
    const existing = this.entries.get(id);
    if (existing) return existing;
    const dir = join(folder.uri.fsPath, STORE_DIR);
    if (folder.uri.scheme !== 'file') return undefined;
    if (!create && !existsSync(dir)) return undefined;
    const label = (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? `Workspace: ${folder.name}` : 'Workspace';
    const entry: StoreEntry = { id, label, kind: 'workspace', store: new FileSystemStore(dir, { id, label, kind: 'workspace' }), baseDir: folder.uri.fsPath, folder };
    await this.add(entry, true);
    if (create) this.structureEmitter.fire();
    return entry;
  }

  list(): StoreEntry[] {
    return [...this.entries.values()].sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'workspace' ? -1 : 1));
  }

  get(id: string): StoreEntry {
    const e = this.entries.get(id);
    if (!e) throw new ReqvynError('NOT_FOUND', `Storage "${id}" is not available.`);
    return e;
  }

  tryGet(id: string): StoreEntry | undefined {
    return this.entries.get(id);
  }

  /** Default store for new collections: the first workspace store, otherwise personal. */
  defaultStore(): StoreEntry {
    return this.list().find((e) => e.kind === 'workspace') ?? this.get(PERSONAL_STORE_ID);
  }

  async loadCollection(storeId: string, collectionId: string): Promise<Collection> {
    return this.get(storeId).store.loadCollection(collectionId);
  }

  async environments(storeId: string): Promise<Environment[]> {
    return this.get(storeId).store.listEnvironments();
  }

  /** Every collection of every store (used by quick open / search). */
  async allCollections(): Promise<Array<{ entry: StoreEntry; collection: Collection }>> {
    const out: Array<{ entry: StoreEntry; collection: Collection }> = [];
    for (const entry of this.list()) {
      for (const s of await entry.store.listCollections()) {
        try {
          out.push({ entry, collection: await entry.store.loadCollection(s.id) });
        } catch {
          /* reported through store problems */
        }
      }
    }
    return out;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const e of this.entries.values()) e.store.dispose();
    this.entries.clear();
    this.emitter.dispose();
    this.structureEmitter.dispose();
  }
}

export function storeIdFor(folder: vscode.WorkspaceFolder): string {
  return `ws:${folder.uri.toString()}`;
}
