import type { JsonValue } from './json.js';

// =============================================================================================
// Snapshots, manifests and revisions
// =============================================================================================

/** Current snapshot format version. Providers must reject snapshots with a newer version. */
export const SYNC_FORMAT_VERSION = 1;

/** Kinds of entities a collection is decomposed into for synchronization. */
export type SyncEntityKind = 'collection' | 'folder' | 'request';

/**
 * One synchronized entity (the collection settings, a folder or a request).
 *
 * `data` is opaque to providers: store and return it unchanged. `hash` is the SHA-256 of the
 * canonical JSON of `data` (see {@link hashJson}); the host verifies it after every pull.
 */
export interface SyncEntity {
  kind: SyncEntityKind;
  hash: string;
  data: JsonValue;
}

/**
 * A deletion marker. Tombstones let other installations distinguish "deleted remotely" from
 * "never seen", so deletions propagate instead of being resurrected.
 */
export interface SyncTombstone {
  /** Stable id of the deleted entity. */
  id: string;
  kind: SyncEntityKind;
  /** ISO-8601 timestamp of the deletion. */
  deletedAt: string;
  /** Revision of the synced state the deletion was based on (`null` if never synced). */
  revisionAt: string | null;
  /** Hash of the entity at the time it was deleted (lets merges detect "modified after delete"). */
  lastHash?: string;
}

/**
 * Full state of one collection as exchanged between REQVYN and a provider.
 */
export interface SyncSnapshot {
  /** Format version, currently {@link SYNC_FORMAT_VERSION}. */
  formatVersion: number;
  collectionId: string;
  /**
   * Opaque revision identifier assigned by the provider (content hash, commit SHA, ETag …).
   * `null` for local snapshots that were never stored remotely.
   */
  revision: string | null;
  /** ISO-8601 timestamp of the last change, informational. */
  updatedAt?: string;
  /** Human-readable collection name (informational, for listing remote collections). */
  label?: string;
  /** Entities keyed by stable id. */
  entities: Record<string, SyncEntity>;
  tombstones: SyncTombstone[];
}

/** Lightweight description of a remote collection: revision and entity hashes, without payloads. */
export interface SyncManifest {
  formatVersion: number;
  collectionId: string;
  revision: string;
  updatedAt: string;
  label?: string;
  entities: Record<string, { kind: SyncEntityKind; hash: string }>;
  tombstoneCount?: number;
}

/** Entry returned by {@link SyncProvider.listRemoteCollections}. */
export interface RemoteCollectionInfo {
  collectionId: string;
  label?: string;
  revision?: string;
  updatedAt?: string;
}

/** Result of a push. A `conflict` means the remote changed since `expectedRevision`. */
export type SyncPushResult =
  | { status: 'ok'; revision: string; updatedAt?: string }
  | { status: 'conflict'; remoteRevision: string | null; message?: string };

/** Result of {@link SyncProvider.testConnection}. */
export interface SyncHealthResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  /** Error code when `ok` is false. */
  code?: string;
  details?: Record<string, unknown>;
}

// =============================================================================================
// Capabilities
// =============================================================================================

/**
 * Capabilities a provider declares. The host negotiates features from these: e.g. a provider
 * without `write` is used for pull only; without `optimisticConcurrency` pushes are not
 * conditional (the host then re-reads the manifest right before pushing to narrow the race).
 */
export interface SyncProviderCapabilities {
  /** Can `pull` / `getRemoteManifest`. */
  read: boolean;
  /** Can `push`. */
  write: boolean;
  /** `push` honours `expectedRevision` atomically and reports `conflict`. */
  optimisticConcurrency: boolean;
  /** Implements `listRemoteCollections`. */
  list: boolean;
  /** Implements `deleteRemoteCollection`. */
  delete: boolean;
  /** Requires / supports an explicit `authenticate()` step. */
  auth: boolean;
}

// =============================================================================================
// Configuration schema
// =============================================================================================

/** Field types a host can render configuration UI for. `secret` values are stored in SecretStorage. */
export type SyncConfigFieldType = 'string' | 'secret' | 'boolean' | 'number' | 'path' | 'url';

/** Description of one configuration field. */
export interface SyncConfigField {
  /** Key used in {@link SyncProviderContext.config} (or in the secret store for `secret`). `[A-Za-z0-9_-]+`. */
  key: string;
  label: string;
  type: SyncConfigFieldType;
  required?: boolean;
  description?: string;
  placeholder?: string;
  /** Default for non-secret fields. */
  default?: string | number | boolean;
}

/** Non-secret configuration value. */
export type SyncConfigValue = string | number | boolean;

/** Non-secret configuration values, keyed by {@link SyncConfigField.key}. */
export type SyncConfigValues = Readonly<Record<string, SyncConfigValue | undefined>>;

// =============================================================================================
// Context given to a provider instance
// =============================================================================================

/**
 * Secret accessor scoped to a single provider *instance*. Keys are namespaced by the host; a
 * provider can never read secrets of other providers or other instances.
 */
export interface ScopedSecretStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Logger supplied by the host. Messages are redacted by the host, but never log secrets. */
export interface SyncLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Phases reported during synchronization. */
export type SyncPhase = 'connect' | 'authenticate' | 'pull' | 'merge' | 'apply' | 'push' | 'retry' | 'done';

/** A progress update. `completed` / `total` are optional work units (e.g. files written). */
export interface SyncProgress {
  phase: SyncPhase;
  message?: string;
  completed?: number;
  total?: number;
  collectionId?: string;
}

/** Receives progress updates. Must not throw; hosts ignore exceptions thrown by reporters. */
export interface SyncProgressReporter {
  report(progress: SyncProgress): void;
}

/** Context passed to {@link SyncProvider.initialize}. */
export interface SyncProviderContext {
  /** Id of the configured provider instance (a user can configure the same provider type several times). */
  readonly instanceId: string;
  /** Non-secret configuration values (validated against the descriptor's schema). */
  readonly config: SyncConfigValues;
  /** Secrets of this instance only (fields of type `secret` are stored under their `key`). */
  readonly secrets: ScopedSecretStorage;
  readonly logger: SyncLogger;
  /** Aborted when the instance is disposed / the host shuts down. */
  readonly signal: AbortSignal;
  /** Host-level progress reporter (per-operation reporters are passed in {@link SyncOperationOptions}). */
  readonly progress: SyncProgressReporter;
  /** Private directory the provider may use for caches / working copies (e.g. a Git clone). */
  readonly storagePath?: string;
}

/** Per-operation options. */
export interface SyncOperationOptions {
  /** Cancels this operation. Providers should pass it to I/O and throw `CANCELLED` when aborted. */
  signal?: AbortSignal;
  progress?: SyncProgressReporter;
}

// =============================================================================================
// Provider contract
// =============================================================================================

/**
 * A synchronization provider instance.
 *
 * Contract:
 * - Store snapshot entities exactly as given (`data` is opaque) and return them unchanged.
 * - `revision` must change whenever the stored content changes.
 * - With `optimisticConcurrency`, `push` must compare `expectedRevision` against the current
 *   revision atomically and return `{ status: 'conflict' }` instead of overwriting.
 * - Throw {@link SyncProviderError} for failures; never leak credentials in messages.
 */
export interface SyncProvider {
  /** Provider type id; equals the descriptor id (e.g. `acme.rest`). */
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: SyncProviderCapabilities;

  /** Called once before any other method. Validate configuration here. */
  initialize(context: SyncProviderContext): Promise<void>;

  /** Interactive / explicit authentication (only when `capabilities.auth`). */
  authenticate?(options?: SyncOperationOptions): Promise<void>;

  /** Lightweight check of the remote revision. Returns `null` if the collection does not exist remotely. */
  getRemoteManifest(collectionId: string, options?: SyncOperationOptions): Promise<SyncManifest | null>;

  /** Full remote snapshot, or `null` if the collection does not exist remotely. */
  pull(collectionId: string, options?: SyncOperationOptions): Promise<SyncSnapshot | null>;

  /**
   * Store `snapshot` as the new remote state.
   * @param expectedRevision `undefined`: unconditional; `null`: only if the collection does not
   *   exist yet; a string: only if the current remote revision equals it.
   */
  push(
    collectionId: string,
    snapshot: SyncSnapshot,
    expectedRevision?: string | null,
    options?: SyncOperationOptions,
  ): Promise<SyncPushResult>;

  testConnection(options?: SyncOperationOptions): Promise<SyncHealthResult>;

  /** Only when `capabilities.list`. */
  listRemoteCollections?(options?: SyncOperationOptions): Promise<RemoteCollectionInfo[]>;

  /** Only when `capabilities.delete`. */
  deleteRemoteCollection?(collectionId: string, expectedRevision?: string | null, options?: SyncOperationOptions): Promise<void>;

  /** Release resources. Must be idempotent. */
  dispose(): Promise<void>;
}

/** Static description of a provider type, used for registration and configuration UI. */
export interface SyncProviderDescriptor {
  /** Globally unique provider type id: `publisher.name`, `[a-z0-9][a-z0-9._-]*`. */
  id: string;
  displayName: string;
  description?: string;
  /** Provider implementation version (semver). */
  version?: string;
  capabilities: SyncProviderCapabilities;
  configSchema: SyncConfigField[];
}

/** What a third party registers: a descriptor plus a factory creating independent instances. */
export interface SyncProviderFactory {
  readonly descriptor: SyncProviderDescriptor;
  /** Create a new, uninitialized instance. The host calls `initialize` afterwards. */
  create(): SyncProvider;
}
