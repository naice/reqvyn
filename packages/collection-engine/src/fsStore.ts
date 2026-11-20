import { watch, promises as fs, type FSWatcher } from 'node:fs';
import { join, relative, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { ReqvynError, slugify, errorMessage, KeyedDebouncer, mapConcurrent } from '@reqvyn/shared';
import {
  SCHEMA_VERSION,
  parseCollectionInfo,
  parseEnvironment,
  parseFolder,
  parseRequest,
  parseWorkspaceConfig,
  migrateDocument,
  type Collection,
  type CollectionInfo,
  type CollectionStore,
  type CollectionSummary,
  type Disposable,
  type Environment,
  type Folder,
  type HttpRequest,
  type StoreChangeEvent,
  type WorkspaceConfig,
} from '@reqvyn/core';
import { atomicWriteFile, FileLock, listDirs, listJsonFiles, readTextIfExists, removeDir, removeFile, SerialQueue, TMP_SUFFIX, exists } from './fsutil.js';
import { stripSecretValues } from './secrets.js';

/**
 * On-disk layout (designed for readable Git diffs and low merge-conflict risk):
 *
 *   .reqvyn/
 *     config.json                         workspace config (variables, collection order)
 *     .gitignore                          ignores lock/tmp/backup files
 *     collections/<slug>.<id8>/
 *       collection.json                   collection info (no children)
 *       folders/<slug>.<id8>.json         one file per folder
 *       requests/<slug>.<id8>.json        one file per request
 *     environments/<slug>.<id8>.json      one file per environment (secret values never stored)
 */
export interface LoadProblem {
  file: string;
  message: string;
}

export interface FileSystemStoreOptions {
  id?: string;
  label?: string;
  kind?: 'personal' | 'workspace';
  /** Watch the directory for external changes (Git pull, other editors). Default false. */
  watch?: boolean;
  /** Remove values of variables marked secret before writing (default true). */
  stripSecrets?: boolean;
}

export interface SaveOptions {
  /** Overwrite even if the file was modified externally since it was last read. */
  force?: boolean;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const id8 = (id: string) => id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'x';
export const fileNameFor = (name: string, id: string) => `${slugify(name) || 'untitled'}.${id8(id)}.json`;
const serialize = (data: unknown) => JSON.stringify(data, null, 2) + '\n';

interface CollectionIndex {
  dir: string;
  /** entity id → absolute file path */
  folders: Map<string, string>;
  requests: Map<string, string>;
}

export class FileSystemStore implements CollectionStore {
  readonly id: string;
  readonly label: string;
  readonly kind: 'personal' | 'workspace';
  private readonly lock: FileLock;
  private readonly queue = new SerialQueue();
  private readonly listeners = new Set<(e: StoreChangeEvent) => void>();
  /** Last content hash we read or wrote per file – used to detect external changes and conflicts. */
  private readonly known = new Map<string, string>();
  private collections = new Map<string, CollectionIndex>();
  private environments = new Map<string, string>();
  private indexed = false;
  private watcher?: FSWatcher;
  private readonly debouncer = new KeyedDebouncer(120);
  private readonly problems: LoadProblem[] = [];
  private readonly strip: boolean;

  constructor(
    readonly root: string,
    opts: FileSystemStoreOptions = {},
  ) {
    this.id = opts.id ?? `fs:${root}`;
    this.label = opts.label ?? basename(root);
    this.kind = opts.kind ?? 'workspace';
    this.strip = opts.stripSecrets !== false;
    this.lock = new FileLock(join(root, '.lock'));
    if (opts.watch) this.startWatching();
  }

  get collectionsDir() {
    return join(this.root, 'collections');
  }
  get environmentsDir() {
    return join(this.root, 'environments');
  }

  /** Files that could not be parsed during the last load (shown to the user, never silently dropped from disk). */
  getProblems(): LoadProblem[] {
    return [...this.problems];
  }

  /** Create the directory skeleton and the .gitignore if missing. */
  async init(): Promise<void> {
    await fs.mkdir(this.collectionsDir, { recursive: true });
    await fs.mkdir(this.environmentsDir, { recursive: true });
    const gi = join(this.root, '.gitignore');
    if (!(await exists(gi))) await atomicWriteFile(gi, ['.lock', `*${TMP_SUFFIX}`, '.backup/', 'local/', ''].join('\n'));
  }

  /**
   * Crash recovery: temp files left by an interrupted write are either promoted (target missing and
   * content valid JSON) or removed (target exists – the rename never happened, the old file is intact).
   */
  async recover(): Promise<{ promoted: string[]; removed: string[] }> {
    const promoted: string[] = [];
    const removed: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '.backup') await walk(p);
          continue;
        }
        if (!e.name.endsWith(TMP_SUFFIX)) continue;
        const target = join(dir, e.name.slice(1).replace(/\.[0-9a-f]{8}\.reqvyn-tmp$/, ''));
        const content = await readTextIfExists(p);
        let valid = false;
        try {
          JSON.parse(content ?? '');
          valid = true;
        } catch {
          valid = false;
        }
        if (!(await exists(target)) && valid && content) {
          await atomicWriteFile(target, content);
          promoted.push(target);
        } else removed.push(p);
        await removeFile(p);
      }
    };
    await walk(this.root);
    return { promoted, removed };
  }

  // ---------------------------------------------------------------- indexing

  private async ensureIndex(): Promise<void> {
    if (this.indexed) return;
    await this.reindex();
  }

  private async reindex(): Promise<void> {
    const collections = new Map<string, CollectionIndex>();
    for (const dir of await listDirs(this.collectionsDir)) {
      const text = await readTextIfExists(join(dir, 'collection.json'));
      if (!text) continue;
      try {
        const id = String((JSON.parse(text) as { id?: unknown }).id ?? '');
        if (!id) throw new Error('missing id');
        if (collections.has(id)) {
          this.problems.push({ file: dir, message: `Duplicate collection id ${id} (also in ${collections.get(id)!.dir}); ignored.` });
          continue;
        }
        collections.set(id, { dir, folders: new Map(), requests: new Map() });
      } catch (e) {
        this.problems.push({ file: join(dir, 'collection.json'), message: errorMessage(e) });
      }
    }
    const environments = new Map<string, string>();
    for (const file of await listJsonFiles(this.environmentsDir)) {
      try {
        const id = String((JSON.parse((await readTextIfExists(file)) ?? '{}') as { id?: unknown }).id ?? '');
        if (id) environments.set(id, file);
      } catch (e) {
        this.problems.push({ file, message: errorMessage(e) });
      }
    }
    this.collections = collections;
    this.environments = environments;
    this.indexed = true;
  }

  private async readJson(file: string): Promise<Record<string, unknown> | undefined> {
    const text = await readTextIfExists(file);
    if (text === undefined) return undefined;
    this.known.set(file, hash(text));
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new ReqvynError('VALIDATION', `Invalid JSON in ${file}: ${(e as Error).message}`, { hint: 'Fix the file manually or restore it from version control.' });
    }
    if (!data || typeof data !== 'object') throw new ReqvynError('VALIDATION', `${file} does not contain a JSON object.`);
    const version = Number((data as { schemaVersion?: unknown }).schemaVersion ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new ReqvynError('VALIDATION', `${file} was written by a newer REQVYN version (schema ${version}).`, { hint: 'Update the REQVYN extension.' });
    }
    return data as Record<string, unknown>;
  }

  /** Write a file, failing with CONFLICT when it changed on disk since we last saw it. */
  private async write(file: string, data: unknown, opts: SaveOptions = {}): Promise<void> {
    const text = serialize(data);
    const current = await readTextIfExists(file);
    if (current !== undefined) {
      const currentHash = hash(current);
      if (currentHash === hash(text)) {
        this.known.set(file, currentHash);
        return; // unchanged – avoid touching mtime (keeps Git and watchers quiet)
      }
      const knownHash = this.known.get(file);
      if (!opts.force && knownHash && knownHash !== currentHash) {
        throw new ReqvynError('CONFLICT', `${relative(this.root, file)} was changed outside REQVYN.`, {
          hint: 'Reload to see the external changes, or save again to overwrite them.',
          details: { file },
        });
      }
    }
    await atomicWriteFile(file, text);
    this.known.set(file, hash(text));
  }

  private async remove(file: string): Promise<void> {
    await removeFile(file);
    this.known.delete(file);
  }

  private emit(e: StoreChangeEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* listener errors must not break storage */
      }
    }
  }

  private async backupFile(file: string): Promise<void> {
    const rel = relative(this.root, file);
    const target = join(this.root, '.backup', new Date().toISOString().replace(/[:.]/g, '-'), rel);
    const content = await readTextIfExists(file);
    if (content !== undefined) await atomicWriteFile(target, content);
  }

  // ---------------------------------------------------------------- collections

  async listCollections(): Promise<CollectionSummary[]> {
    await this.reindex();
    const out: CollectionSummary[] = [];
    for (const [id, idx] of this.collections) {
      try {
        const info = await this.readJson(join(idx.dir, 'collection.json'));
        out.push({
          id,
          name: String(info?.name ?? 'Untitled'),
          requestCount: (await listJsonFiles(join(idx.dir, 'requests'))).length,
          folderCount: (await listJsonFiles(join(idx.dir, 'folders'))).length,
        });
      } catch (e) {
        this.problems.push({ file: idx.dir, message: errorMessage(e) });
      }
    }
    return out;
  }

  async loadCollection(id: string): Promise<Collection> {
    await this.ensureIndex();
    let idx = this.collections.get(id);
    if (!idx) {
      await this.reindex();
      idx = this.collections.get(id);
    }
    if (!idx) throw new ReqvynError('NOT_FOUND', `Collection ${id} not found.`);
    const infoFile = join(idx.dir, 'collection.json');
    const raw = await this.readJson(infoFile);
    if (!raw) throw new ReqvynError('NOT_FOUND', `Collection ${id} not found.`);
    const migrated = migrateDocument(raw);
    if (migrated.migrated) await this.backupFile(infoFile);
    const info = parseCollectionInfo(migrated.doc);
    const folders: Folder[] = [];
    const requests: HttpRequest[] = [];
    idx.folders.clear();
    idx.requests.clear();
    for (const file of await listJsonFiles(join(idx.dir, 'folders'))) {
      try {
        const f = parseFolder(await this.readJson(file));
        if (idx.folders.has(f.id)) throw new Error(`duplicate folder id ${f.id}`);
        idx.folders.set(f.id, file);
        folders.push(f);
      } catch (e) {
        this.problems.push({ file, message: errorMessage(e) });
      }
    }
    for (const file of await listJsonFiles(join(idx.dir, 'requests'))) {
      try {
        const r = parseRequest(await this.readJson(file));
        if (idx.requests.has(r.id)) throw new Error(`duplicate request id ${r.id}`);
        idx.requests.set(r.id, file);
        requests.push(r);
      } catch (e) {
        this.problems.push({ file, message: errorMessage(e) });
      }
    }
    const collection: Collection = { ...info, folders, requests };
    if (migrated.migrated) await this.saveCollectionInfo(info, { force: true });
    return collection;
  }

  private collectionDirFor(info: CollectionInfo): string {
    return this.collections.get(info.id)?.dir ?? join(this.collectionsDir, fileNameFor(info.name, info.id).replace(/\.json$/, ''));
  }

  async saveCollection(collection: Collection, opts: SaveOptions = {}): Promise<void> {
    await this.ensureIndex();
    await this.queue.run(() =>
      this.lock.run(async () => {
        const { folders, requests, ...info } = collection;
        await this.writeInfo(info, opts);
        const idx = this.collections.get(info.id)!;
        // Refresh index from disk so we can remove entities that no longer exist.
        const existingFolders = await this.scanEntities(join(idx.dir, 'folders'));
        const existingRequests = await this.scanEntities(join(idx.dir, 'requests'));
        for (const [eid, file] of existingFolders) if (!idx.folders.has(eid)) idx.folders.set(eid, file);
        for (const [eid, file] of existingRequests) if (!idx.requests.has(eid)) idx.requests.set(eid, file);
        await mapConcurrent(folders, 16, (f) => this.writeEntity(idx, 'folders', f, opts, true));
        await mapConcurrent(requests, 16, (r) => this.writeEntity(idx, 'requests', r, opts, true));
        const keepF = new Set(folders.map((f) => f.id));
        const keepR = new Set(requests.map((r) => r.id));
        for (const [eid, file] of existingFolders) if (!keepF.has(eid)) await this.remove(file);
        for (const [eid, file] of existingRequests) if (!keepR.has(eid)) await this.remove(file);
      }),
    );
    this.emit({ kind: 'collection', id: collection.id, origin: 'internal' });
  }

  private async scanEntities(dir: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const file of await listJsonFiles(dir)) {
      try {
        const id = String((JSON.parse((await readTextIfExists(file)) ?? '{}') as { id?: unknown }).id ?? '');
        if (id) out.set(id, file);
      } catch {
        /* leave unparsable files alone */
      }
    }
    return out;
  }

  private async writeInfo(info: CollectionInfo, opts: SaveOptions): Promise<void> {
    const dir = this.collectionDirFor(info);
    if (!this.collections.has(info.id)) this.collections.set(info.id, { dir, folders: new Map(), requests: new Map() });
    const clean = this.strip ? stripSecretValues(info) : info;
    await this.write(join(dir, 'collection.json'), { ...clean, schemaVersion: SCHEMA_VERSION }, opts);
  }

  private async writeEntity(
    idx: CollectionIndex,
    kind: 'folders' | 'requests',
    entity: Folder | HttpRequest,
    opts: SaveOptions,
    indexFresh = false,
  ): Promise<void> {
    const map = idx[kind];
    if (!indexFresh && !map.has(entity.id)) {
      const found = (await this.scanEntities(join(idx.dir, kind))).get(entity.id);
      if (found) map.set(entity.id, found);
    }
    const target = join(idx.dir, kind, fileNameFor(entity.name, entity.id));
    const previous = map.get(entity.id);
    const clean = this.strip ? stripSecretValues(entity) : entity;
    if (previous && previous !== target) {
      // Renamed: carry over the conflict baseline, write the new file, then remove the old one.
      const prevHash = this.known.get(previous);
      const current = await readTextIfExists(previous);
      if (!opts.force && prevHash && current !== undefined && hash(current) !== prevHash) {
        throw new ReqvynError('CONFLICT', `${relative(this.root, previous)} was changed outside REQVYN.`, { details: { file: previous } });
      }
      await this.write(target, { schemaVersion: SCHEMA_VERSION, ...clean }, { force: true });
      await this.remove(previous);
    } else {
      await this.write(target, { schemaVersion: SCHEMA_VERSION, ...clean }, opts);
    }
    map.set(entity.id, target);
  }

  async saveCollectionInfo(info: CollectionInfo, opts: SaveOptions = {}): Promise<void> {
    await this.ensureIndex();
    await this.queue.run(() => this.lock.run(() => this.writeInfo(info, opts)));
    this.emit({ kind: 'collection', id: info.id, origin: 'internal' });
  }

  private async requireIndex(collectionId: string): Promise<CollectionIndex> {
    await this.ensureIndex();
    let idx = this.collections.get(collectionId);
    if (!idx) {
      await this.reindex();
      idx = this.collections.get(collectionId);
    }
    if (!idx) throw new ReqvynError('NOT_FOUND', `Collection ${collectionId} not found.`);
    return idx;
  }

  async saveRequest(collectionId: string, request: HttpRequest, opts: SaveOptions = {}): Promise<void> {
    const idx = await this.requireIndex(collectionId);
    await this.queue.run(() => this.lock.run(() => this.writeEntity(idx, 'requests', request, opts)));
    this.emit({ kind: 'collection', id: collectionId, origin: 'internal' });
  }

  async saveFolder(collectionId: string, folder: Folder, opts: SaveOptions = {}): Promise<void> {
    const idx = await this.requireIndex(collectionId);
    await this.queue.run(() => this.lock.run(() => this.writeEntity(idx, 'folders', folder, opts)));
    this.emit({ kind: 'collection', id: collectionId, origin: 'internal' });
  }

  private async deleteEntity(collectionId: string, kind: 'folders' | 'requests', id: string): Promise<void> {
    const idx = await this.requireIndex(collectionId);
    await this.queue.run(() =>
      this.lock.run(async () => {
        const file = idx[kind].get(id) ?? (await this.scanEntities(join(idx.dir, kind))).get(id);
        if (file) await this.remove(file);
        idx[kind].delete(id);
      }),
    );
    this.emit({ kind: 'collection', id: collectionId, origin: 'internal' });
  }

  deleteRequest(collectionId: string, requestId: string): Promise<void> {
    return this.deleteEntity(collectionId, 'requests', requestId);
  }

  /** Deletes only the folder file. Callers remove descendants explicitly (see `deleteNode` mutation + saveCollection). */
  deleteFolder(collectionId: string, folderId: string): Promise<void> {
    return this.deleteEntity(collectionId, 'folders', folderId);
  }

  async deleteCollection(id: string): Promise<void> {
    const idx = await this.requireIndex(id);
    await this.queue.run(() =>
      this.lock.run(async () => {
        await removeDir(idx.dir);
        for (const k of [...this.known.keys()]) if (k.startsWith(idx.dir + sep)) this.known.delete(k);
        this.collections.delete(id);
      }),
    );
    this.emit({ kind: 'collection', id, origin: 'internal' });
  }

  // ---------------------------------------------------------------- environments & config

  async listEnvironments(): Promise<Environment[]> {
    await this.reindex();
    const out: Environment[] = [];
    for (const [, file] of this.environments) {
      try {
        out.push(parseEnvironment(await this.readJson(file)));
      } catch (e) {
        this.problems.push({ file, message: errorMessage(e) });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveEnvironment(env: Environment, opts: SaveOptions = {}): Promise<void> {
    await this.ensureIndex();
    await this.queue.run(() =>
      this.lock.run(async () => {
        const target = join(this.environmentsDir, fileNameFor(env.name, env.id));
        const previous = this.environments.get(env.id);
        const clean = this.strip ? stripSecretValues(env) : env;
        await this.write(target, { ...clean, schemaVersion: SCHEMA_VERSION }, previous && previous !== target ? { force: true } : opts);
        if (previous && previous !== target) await this.remove(previous);
        this.environments.set(env.id, target);
      }),
    );
    this.emit({ kind: 'environment', id: env.id, origin: 'internal' });
  }

  async deleteEnvironment(id: string): Promise<void> {
    await this.ensureIndex();
    await this.queue.run(() =>
      this.lock.run(async () => {
        const file = this.environments.get(id);
        if (file) await this.remove(file);
        this.environments.delete(id);
      }),
    );
    this.emit({ kind: 'environment', id, origin: 'internal' });
  }

  async loadConfig(): Promise<WorkspaceConfig> {
    const raw = await this.readJson(join(this.root, 'config.json')).catch((e) => {
      this.problems.push({ file: join(this.root, 'config.json'), message: errorMessage(e) });
      return undefined;
    });
    return parseWorkspaceConfig(raw ?? {});
  }

  async saveConfig(config: WorkspaceConfig, opts: SaveOptions = {}): Promise<void> {
    await this.queue.run(() =>
      this.lock.run(() => this.write(join(this.root, 'config.json'), { ...(this.strip ? stripSecretValues(config) : config), schemaVersion: SCHEMA_VERSION }, opts)),
    );
    this.emit({ kind: 'config', origin: 'internal' });
  }

  // ---------------------------------------------------------------- change detection

  onDidChange(listener: (e: StoreChangeEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /**
   * Inform the store that a file under the root changed (e.g. from a VS Code FileSystemWatcher).
   * Changes caused by our own writes are ignored by comparing content hashes.
   */
  async notifyFileChanged(absPath: string): Promise<void> {
    const rel = relative(this.root, absPath);
    if (!rel || rel.startsWith('..')) return;
    const parts = rel.split(/[\\/]/);
    if (parts.some((p) => p.startsWith('.')) || absPath.endsWith(TMP_SUFFIX)) return;
    const content = await readTextIfExists(absPath).catch(() => undefined);
    const known = this.known.get(absPath);
    if (content !== undefined && known === hash(content)) return; // our own write
    if (content === undefined && known === undefined && !absPath.endsWith('.json')) return;
    if (parts[0] === 'collections' && parts[1]) {
      const dir = join(this.collectionsDir, parts[1]);
      const entry = [...this.collections].find(([, idx]) => idx.dir === dir);
      if (!entry) await this.reindex();
      const id = entry?.[0] ?? [...this.collections].find(([, idx]) => idx.dir === dir)?.[0];
      this.emit({ kind: 'collection', id, origin: 'external' });
    } else if (parts[0] === 'environments') {
      this.indexed = false;
      this.emit({ kind: 'environment', origin: 'external' });
    } else if (parts[0] === 'config.json') {
      this.emit({ kind: 'config', origin: 'external' });
    }
  }

  private startWatching(): void {
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const abs = join(this.root, filename.toString());
        this.debouncer.schedule(abs, () => void this.notifyFileChanged(abs));
      });
      this.watcher.on('error', () => undefined);
    } catch {
      // Recursive watching unsupported or root missing – callers can feed notifyFileChanged instead.
    }
  }

  dispose(): void {
    this.watcher?.close();
    this.debouncer.dispose();
    this.listeners.clear();
  }
}
