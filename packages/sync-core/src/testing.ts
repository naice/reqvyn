import type { Collection } from '@reqvyn/core';
import {
  SyncProviderError,
  computeSnapshotRevision,
  manifestFromSnapshot,
  throwIfCancelled,
  type RemoteCollectionInfo,
  type SyncHealthResult,
  type SyncManifest,
  type SyncOperationOptions,
  type SyncProvider,
  type SyncProviderCapabilities,
  type SyncProviderContext,
  type SyncProviderErrorCode,
  type SyncPushResult,
  type SyncSnapshot,
} from '@reqvyn/provider-sdk';

/**
 * Test doubles for the sync subsystem: an in-memory remote and a fault-injecting wrapper.
 * Exported so hosts and third-party providers can reuse them in their own tests.
 */

/** Shared in-memory "server" that several {@link MemorySyncProvider} instances can point at. */
export class MemoryRemoteStore {
  readonly collections = new Map<string, SyncSnapshot>();
  pushes = 0;
}

export class MemorySyncProvider implements SyncProvider {
  readonly id = 'reqvyn.memory';
  readonly displayName = 'In-memory (testing)';
  readonly capabilities: SyncProviderCapabilities;

  constructor(
    readonly remote: MemoryRemoteStore = new MemoryRemoteStore(),
    options: { optimisticConcurrency?: boolean; write?: boolean } = {},
  ) {
    const write = options.write ?? true;
    this.capabilities = {
      read: true,
      write,
      optimisticConcurrency: write && (options.optimisticConcurrency ?? true),
      list: true,
      delete: true,
      auth: false,
    };
  }

  async initialize(_context: SyncProviderContext): Promise<void> {}

  async getRemoteManifest(collectionId: string): Promise<SyncManifest | null> {
    const s = this.remote.collections.get(collectionId);
    return s ? manifestFromSnapshot(s) : null;
  }

  async pull(collectionId: string, options?: SyncOperationOptions): Promise<SyncSnapshot | null> {
    throwIfCancelled(options?.signal);
    const s = this.remote.collections.get(collectionId);
    return s ? structuredClone(s) : null;
  }

  async push(collectionId: string, snapshot: SyncSnapshot, expectedRevision?: string | null, options?: SyncOperationOptions): Promise<SyncPushResult> {
    throwIfCancelled(options?.signal);
    const current = this.remote.collections.get(collectionId) ?? null;
    if (this.capabilities.optimisticConcurrency && expectedRevision !== undefined && (current?.revision ?? null) !== expectedRevision) {
      return { status: 'conflict', remoteRevision: current?.revision ?? null };
    }
    const updatedAt = new Date().toISOString();
    const stored: SyncSnapshot = { ...structuredClone(snapshot), collectionId, updatedAt, revision: null };
    stored.revision = computeSnapshotRevision(stored);
    this.remote.collections.set(collectionId, stored);
    this.remote.pushes++;
    return { status: 'ok', revision: stored.revision, updatedAt };
  }

  async testConnection(): Promise<SyncHealthResult> {
    return { ok: true, message: 'In-memory remote' };
  }

  async listRemoteCollections(): Promise<RemoteCollectionInfo[]> {
    return [...this.remote.collections.values()].map((s) => ({ collectionId: s.collectionId, label: s.label, revision: s.revision ?? undefined }));
  }

  async deleteRemoteCollection(collectionId: string): Promise<void> {
    this.remote.collections.delete(collectionId);
  }

  async dispose(): Promise<void> {}
}

type Op = 'pull' | 'push' | 'getRemoteManifest' | 'testConnection';

/**
 * Wraps a provider and injects failures: offline mode, the next N calls failing, lost push
 * responses (write succeeded but the client never heard back) and hooks to interleave a concurrent
 * writer right before a push.
 */
export class FlakySyncProvider implements SyncProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: SyncProviderCapabilities;
  offline = false;
  readonly calls: Record<Op, number> = { pull: 0, push: 0, getRemoteManifest: 0, testConnection: 0 };
  private failures: Array<{ ops: Op[] | null; code: SyncProviderErrorCode }> = [];
  private loseResponses = 0;
  /** Called (once per push) before the inner push – e.g. to simulate another writer. */
  beforePush?: () => Promise<void>;

  constructor(readonly inner: SyncProvider) {
    this.id = inner.id;
    this.displayName = inner.displayName;
    this.capabilities = inner.capabilities;
  }

  /** The next `count` matching calls fail with `code`. */
  failNext(count: number, code: SyncProviderErrorCode = 'NETWORK', ops: Op[] | null = null): this {
    for (let i = 0; i < count; i++) this.failures.push({ ops, code });
    return this;
  }

  /** The next `count` pushes are applied remotely but report a network failure to the caller. */
  loseNextPushResponses(count = 1): this {
    this.loseResponses += count;
    return this;
  }

  private gate(op: Op) {
    this.calls[op]++;
    if (this.offline) throw new SyncProviderError('NETWORK', 'Simulated network outage (offline)');
    const idx = this.failures.findIndex((f) => !f.ops || f.ops.includes(op));
    if (idx >= 0) {
      const [f] = this.failures.splice(idx, 1);
      throw new SyncProviderError(f!.code, `Simulated ${f!.code} failure during ${op}`);
    }
  }

  initialize(context: SyncProviderContext): Promise<void> {
    return this.inner.initialize(context);
  }

  async getRemoteManifest(collectionId: string, options?: SyncOperationOptions) {
    this.gate('getRemoteManifest');
    return this.inner.getRemoteManifest(collectionId, options);
  }

  async pull(collectionId: string, options?: SyncOperationOptions) {
    this.gate('pull');
    return this.inner.pull(collectionId, options);
  }

  async push(collectionId: string, snapshot: SyncSnapshot, expectedRevision?: string | null, options?: SyncOperationOptions) {
    this.gate('push');
    if (this.beforePush) {
      const hook = this.beforePush;
      this.beforePush = undefined;
      await hook();
    }
    const res = await this.inner.push(collectionId, snapshot, expectedRevision, options);
    if (this.loseResponses > 0) {
      this.loseResponses--;
      throw new SyncProviderError('NETWORK', 'Simulated connection reset after the write was applied');
    }
    return res;
  }

  async testConnection(options?: SyncOperationOptions) {
    this.gate('testConnection');
    return this.inner.testConnection(options);
  }

  listRemoteCollections(options?: SyncOperationOptions) {
    return this.inner.listRemoteCollections?.(options) ?? Promise.resolve([]);
  }

  dispose(): Promise<void> {
    return this.inner.dispose();
  }
}

/** In-memory local collection copy (one "installation"). */
export class MemoryLocalCollections {
  readonly collections = new Map<string, Collection>();
  saves = 0;
  async load(id: string): Promise<Collection | null> {
    const c = this.collections.get(id);
    return c ? structuredClone(c) : null;
  }
  async save(c: Collection): Promise<void> {
    this.saves++;
    this.collections.set(c.id, structuredClone(c));
  }
}

/**
 * Minimal {@link SyncProviderContext} for unit-testing a provider without a registry. Secrets are
 * kept in an in-memory map private to the returned context.
 */
export function createTestProviderContext(
  config: Record<string, string | number | boolean | undefined> = {},
  options: { secrets?: Record<string, string>; instanceId?: string; storagePath?: string; signal?: AbortSignal } = {},
): SyncProviderContext {
  const secrets = new Map(Object.entries(options.secrets ?? {}));
  const values: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(config)) if (v !== undefined) values[k] = v;
  return Object.freeze({
    instanceId: options.instanceId ?? 'test',
    config: Object.freeze(values),
    secrets: {
      get: async (key: string) => secrets.get(key),
      set: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: options.signal ?? new AbortController().signal,
    progress: { report() {} },
    storagePath: options.storagePath,
  });
}
