import type { Collection, CollectionInfo, Environment, Folder, HttpRequest, WorkspaceConfig } from './models.js';

/**
 * Replaceable storage engine interface. The default implementation (`FileSystemStore` in
 * @reqvyn/collection-engine) stores one file per entity; an in-memory store is used in tests.
 */
export interface CollectionSummary {
  id: string;
  name: string;
  requestCount: number;
  folderCount: number;
}

export interface StoreChangeEvent {
  kind: 'collection' | 'environment' | 'config';
  id?: string;
  /** `external` when the change was detected on disk (e.g. after a Git pull), not made by this process. */
  origin: 'internal' | 'external';
}

export interface Disposable {
  dispose(): void;
}

export interface CollectionStore {
  readonly id: string;
  readonly label: string;
  readonly kind: 'personal' | 'workspace' | 'memory';

  listCollections(): Promise<CollectionSummary[]>;
  loadCollection(id: string): Promise<Collection>;
  /** Replace an entire collection (used by import, sync and migrations). */
  saveCollection(collection: Collection): Promise<void>;
  saveCollectionInfo(info: CollectionInfo): Promise<void>;
  saveRequest(collectionId: string, request: HttpRequest): Promise<void>;
  saveFolder(collectionId: string, folder: Folder): Promise<void>;
  deleteRequest(collectionId: string, requestId: string): Promise<void>;
  deleteFolder(collectionId: string, folderId: string): Promise<void>;
  deleteCollection(id: string): Promise<void>;

  listEnvironments(): Promise<Environment[]>;
  saveEnvironment(env: Environment): Promise<void>;
  deleteEnvironment(id: string): Promise<void>;

  loadConfig(): Promise<WorkspaceConfig>;
  saveConfig(config: WorkspaceConfig): Promise<void>;

  onDidChange(listener: (e: StoreChangeEvent) => void): Disposable;
  dispose(): void;
}

/** Secret storage abstraction (VS Code SecretStorage in the extension, environment variables in the CLI). */
export interface SecretVault {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export class MemorySecretVault implements SecretVault {
  private readonly map = new Map<string, string>();
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.map.set(k, v);
  }
  async get(name: string) {
    return this.map.get(name);
  }
  async set(name: string, value: string) {
    this.map.set(name, value);
  }
  async delete(name: string) {
    this.map.delete(name);
  }
  entries(): Array<[string, string]> {
    return [...this.map.entries()];
  }
}

/** Naming convention for vault keys. */
export const secretKeys = {
  environmentVariable: (envId: string, key: string) => `env.${envId}.${key}`,
  globalVariable: (key: string) => `global.${key}`,
  named: (name: string) => `named.${name}`,
  oauthToken: (cacheKey: string) => `oauth2.${cacheKey}`,
  syncProvider: (providerInstanceId: string, field: string) => `sync.${providerInstanceId}.${field}`,
};
