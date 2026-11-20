import { ReqvynError, deepClone } from '@reqvyn/shared';
import {
  parseWorkspaceConfig,
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

/** In-memory store (tests, untrusted workspaces, scratch collections). */
export class MemoryStore implements CollectionStore {
  readonly kind = 'memory' as const;
  private readonly collections = new Map<string, Collection>();
  private readonly environments = new Map<string, Environment>();
  private config: WorkspaceConfig = parseWorkspaceConfig({});
  private readonly listeners = new Set<(e: StoreChangeEvent) => void>();

  constructor(
    readonly id = 'memory',
    readonly label = 'Memory',
  ) {}

  private emit(e: StoreChangeEvent) {
    for (const l of this.listeners) l(e);
  }

  private get(id: string): Collection {
    const c = this.collections.get(id);
    if (!c) throw new ReqvynError('NOT_FOUND', `Collection ${id} not found.`);
    return c;
  }

  async listCollections(): Promise<CollectionSummary[]> {
    return [...this.collections.values()].map((c) => ({ id: c.id, name: c.name, requestCount: c.requests.length, folderCount: c.folders.length }));
  }
  async loadCollection(id: string): Promise<Collection> {
    return deepClone(this.get(id));
  }
  async saveCollection(collection: Collection): Promise<void> {
    this.collections.set(collection.id, deepClone(collection));
    this.emit({ kind: 'collection', id: collection.id, origin: 'internal' });
  }
  async saveCollectionInfo(info: CollectionInfo): Promise<void> {
    const existing = this.collections.get(info.id);
    this.collections.set(info.id, { ...deepClone(info), folders: existing?.folders ?? [], requests: existing?.requests ?? [] });
    this.emit({ kind: 'collection', id: info.id, origin: 'internal' });
  }
  async saveRequest(collectionId: string, request: HttpRequest): Promise<void> {
    const c = this.get(collectionId);
    c.requests = [...c.requests.filter((r) => r.id !== request.id), deepClone(request)];
    this.emit({ kind: 'collection', id: collectionId, origin: 'internal' });
  }
  async saveFolder(collectionId: string, folder: Folder): Promise<void> {
    const c = this.get(collectionId);
    c.folders = [...c.folders.filter((f) => f.id !== folder.id), deepClone(folder)];
    this.emit({ kind: 'collection', id: collectionId, origin: 'internal' });
  }
  async deleteRequest(collectionId: string, requestId: string): Promise<void> {
    const c = this.get(collectionId);
    c.requests = c.requests.filter((r) => r.id !== requestId);
    this.emit({ kind: 'collection', id: collectionId, origin: 'internal' });
  }
  async deleteFolder(collectionId: string, folderId: string): Promise<void> {
    const c = this.get(collectionId);
    c.folders = c.folders.filter((f) => f.id !== folderId);
    this.emit({ kind: 'collection', id: collectionId, origin: 'internal' });
  }
  async deleteCollection(id: string): Promise<void> {
    this.collections.delete(id);
    this.emit({ kind: 'collection', id, origin: 'internal' });
  }
  async listEnvironments(): Promise<Environment[]> {
    return [...this.environments.values()].map((e) => deepClone(e));
  }
  async saveEnvironment(env: Environment): Promise<void> {
    this.environments.set(env.id, deepClone(env));
    this.emit({ kind: 'environment', id: env.id, origin: 'internal' });
  }
  async deleteEnvironment(id: string): Promise<void> {
    this.environments.delete(id);
    this.emit({ kind: 'environment', id, origin: 'internal' });
  }
  async loadConfig(): Promise<WorkspaceConfig> {
    return deepClone(this.config);
  }
  async saveConfig(config: WorkspaceConfig): Promise<void> {
    this.config = deepClone(config);
    this.emit({ kind: 'config', origin: 'internal' });
  }
  onDidChange(listener: (e: StoreChangeEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  dispose(): void {
    this.listeners.clear();
  }
}
