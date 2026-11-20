import { secretKeys, type SecretVault } from '@reqvyn/core';
import { ReqvynError } from '@reqvyn/shared';
import {
  SyncProviderError,
  toSyncProviderError,
  validateConfigValues,
  validateDescriptor,
  validateSnapshot,
  type Disposable,
  type RemoteCollectionInfo,
  type ScopedSecretStorage,
  type SyncHealthResult,
  type SyncLogger,
  type SyncManifest,
  type SyncOperationOptions,
  type SyncProgressReporter,
  type SyncProvider,
  type SyncProviderCapabilities,
  type SyncProviderContext,
  type SyncProviderDescriptor,
  type SyncProviderFactory,
  type SyncPushResult,
  type SyncSnapshot,
} from '@reqvyn/provider-sdk';

const INSTANCE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const noopLogger: SyncLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Secret accessor confined to `sync.<instanceId>.<key>`. Neither the instance id nor keys may
 * contain `.`, so one instance can never address another instance's (or any non-sync) secret.
 */
export function createScopedSecrets(vault: SecretVault, instanceId: string): ScopedSecretStorage {
  if (!INSTANCE_ID_RE.test(instanceId)) throw new ReqvynError('VALIDATION', `Invalid provider instance id "${instanceId}"`);
  const name = (key: string) => {
    if (typeof key !== 'string' || !SECRET_KEY_RE.test(key)) {
      throw new SyncProviderError('PERMISSION', 'Secret keys must match [A-Za-z0-9_-]{1,64}');
    }
    return secretKeys.syncProvider(instanceId, key);
  };
  return Object.freeze({
    get: async (key: string) => vault.get(name(key)),
    set: async (key: string, value: string) => {
      if (typeof value !== 'string') throw new SyncProviderError('INVALID_DATA', 'Secret values must be strings');
      return vault.set(name(key), value);
    },
    delete: async (key: string) => vault.delete(name(key)),
  });
}

function safeLogger(logger: SyncLogger, prefix: string): SyncLogger {
  const wrap =
    (fn: (m: string, d?: Record<string, unknown>) => void) =>
    (m: string, d?: Record<string, unknown>) => {
      try {
        fn(`[${prefix}] ${m}`, d);
      } catch {
        /* never let logging break sync */
      }
    };
  return { debug: wrap(logger.debug.bind(logger)), info: wrap(logger.info.bind(logger)), warn: wrap(logger.warn.bind(logger)), error: wrap(logger.error.bind(logger)) };
}

function safeProgress(reporter?: SyncProgressReporter): SyncProgressReporter {
  return {
    report(p) {
      try {
        reporter?.report(p);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Wraps a provider so the host is isolated from it: every error becomes a `SyncProviderError`,
 * results are validated, unsupported operations are refused, and inputs are deep-copied so a
 * provider can never mutate engine state.
 */
export class GuardedSyncProvider implements SyncProvider {
  private disposed = false;
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: SyncProviderCapabilities;

  constructor(
    readonly inner: SyncProvider,
    private readonly abort?: AbortController,
    /** Capabilities declared at registration; the effective set is the intersection with the instance's. */
    declared?: SyncProviderCapabilities,
  ) {
    this.id = inner.id;
    this.displayName = inner.displayName;
    const own = inner.capabilities;
    const keys = ['read', 'write', 'optimisticConcurrency', 'list', 'delete', 'auth'] as const;
    const caps = {} as Record<(typeof keys)[number], boolean>;
    for (const k of keys) caps[k] = own?.[k] === true && (declared ? declared[k] === true : true);
    this.capabilities = Object.freeze(caps);
  }

  private async call<T>(op: string, fn: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new SyncProviderError('UNAVAILABLE', 'Provider instance has been disposed', { retryable: false });
    try {
      return await fn();
    } catch (e) {
      throw toSyncProviderError(e, `${this.displayName}: ${op} failed`);
    }
  }

  initialize(context: SyncProviderContext): Promise<void> {
    return this.call('initialize', () => this.inner.initialize(context));
  }

  authenticate(options?: SyncOperationOptions): Promise<void> {
    return this.call('authenticate', async () => {
      if (this.inner.authenticate) await this.inner.authenticate(options);
    });
  }

  getRemoteManifest(collectionId: string, options?: SyncOperationOptions): Promise<SyncManifest | null> {
    return this.call('getRemoteManifest', async () => {
      if (!this.capabilities.read) throw new SyncProviderError('PERMISSION', 'Provider cannot read');
      let m: SyncManifest | null;
      try {
        m = await this.inner.getRemoteManifest(collectionId, options);
      } catch (e) {
        if (toSyncProviderError(e).code === 'NOT_FOUND') return null;
        throw e;
      }
      if (m === null || m === undefined) return null;
      if (typeof m !== 'object' || typeof m.revision !== 'string' || m.collectionId !== collectionId) {
        throw new SyncProviderError('INVALID_DATA', 'Provider returned an invalid manifest');
      }
      return structuredClone(m);
    });
  }

  pull(collectionId: string, options?: SyncOperationOptions): Promise<SyncSnapshot | null> {
    return this.call('pull', async () => {
      if (!this.capabilities.read) throw new SyncProviderError('PERMISSION', 'Provider cannot read');
      let s: SyncSnapshot | null;
      try {
        s = await this.inner.pull(collectionId, options);
      } catch (e) {
        if (toSyncProviderError(e).code === 'NOT_FOUND') return null;
        throw e;
      }
      if (s === null || s === undefined) return null;
      const v = validateSnapshot(s, { collectionId });
      if (!v.revision) throw new SyncProviderError('INVALID_DATA', 'Provider returned a snapshot without revision');
      return v;
    });
  }

  push(collectionId: string, snapshot: SyncSnapshot, expectedRevision?: string | null, options?: SyncOperationOptions): Promise<SyncPushResult> {
    return this.call('push', async () => {
      if (!this.capabilities.write) throw new SyncProviderError('PERMISSION', 'Provider is read-only');
      const r = await this.inner.push(collectionId, structuredClone(snapshot), expectedRevision, options);
      if (r?.status === 'ok' && typeof r.revision === 'string' && r.revision) return { ...r };
      if (r?.status === 'conflict') return { status: 'conflict', remoteRevision: r.remoteRevision ?? null, message: r.message };
      throw new SyncProviderError('INVALID_DATA', 'Provider returned an invalid push result');
    });
  }

  async testConnection(options?: SyncOperationOptions): Promise<SyncHealthResult> {
    try {
      const r = await this.call('testConnection', () => this.inner.testConnection(options));
      return { ok: !!r.ok, message: String(r.message ?? ''), latencyMs: r.latencyMs, code: r.code, details: r.details };
    } catch (e) {
      const err = toSyncProviderError(e);
      return { ok: false, message: err.message, code: err.code };
    }
  }

  listRemoteCollections(options?: SyncOperationOptions): Promise<RemoteCollectionInfo[]> {
    return this.call('listRemoteCollections', async () => {
      if (!this.capabilities.list || !this.inner.listRemoteCollections) throw new SyncProviderError('PERMISSION', 'Provider cannot list collections');
      const list = await this.inner.listRemoteCollections(options);
      if (!Array.isArray(list)) throw new SyncProviderError('INVALID_DATA', 'Provider returned an invalid collection list');
      return list.filter((x) => x && typeof x.collectionId === 'string').map((x) => ({ ...x }));
    });
  }

  deleteRemoteCollection(collectionId: string, expectedRevision?: string | null, options?: SyncOperationOptions): Promise<void> {
    return this.call('deleteRemoteCollection', async () => {
      if (!this.capabilities.delete || !this.inner.deleteRemoteCollection) throw new SyncProviderError('PERMISSION', 'Provider cannot delete collections');
      await this.inner.deleteRemoteCollection(collectionId, expectedRevision, options);
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abort?.abort();
    try {
      await this.inner.dispose();
    } catch {
      /* isolate provider failures during shutdown */
    }
  }
}

export interface ProviderInstanceOptions {
  instanceId: string;
  providerId: string;
  /** Non-secret configuration values. */
  config?: Record<string, unknown>;
  /** Private storage directory for this instance. */
  storagePath?: string;
  progress?: SyncProgressReporter;
}

export interface RegistryChangeEvent {
  type: 'registered' | 'unregistered';
  providerId: string;
}

interface Registration {
  factory: SyncProviderFactory;
  descriptor: SyncProviderDescriptor;
  source: string;
}

/**
 * Registry of provider types. Registration validates the descriptor and rejects duplicate ids;
 * instance creation validates configuration and hands each instance its own secret scope.
 */
export class SyncProviderRegistry {
  private readonly registrations = new Map<string, Registration>();
  private readonly listeners = new Set<(e: RegistryChangeEvent) => void>();
  private readonly logger: SyncLogger;

  constructor(private readonly options: { vault: SecretVault; logger?: SyncLogger }) {
    this.logger = options.logger ?? noopLogger;
  }

  register(factory: SyncProviderFactory, source = 'unknown'): Disposable {
    if (typeof factory !== 'object' || factory === null || typeof factory.create !== 'function') {
      throw new ReqvynError('VALIDATION', 'A sync provider factory must have a descriptor and a create() function');
    }
    let descriptor: SyncProviderDescriptor;
    try {
      descriptor = structuredClone(factory.descriptor);
    } catch {
      throw new ReqvynError('VALIDATION', 'Sync provider descriptor must be plain data');
    }
    const issues = validateDescriptor(descriptor);
    if (issues.length) {
      throw new ReqvynError('VALIDATION', `Invalid sync provider descriptor: ${issues.map((i) => i.message).join('; ')}`, { details: { issues } });
    }
    if (this.registrations.has(descriptor.id)) {
      throw new ReqvynError('CONFLICT', `A sync provider with id "${descriptor.id}" is already registered`);
    }
    deepFreeze(descriptor);
    const reg: Registration = { factory, descriptor, source };
    this.registrations.set(descriptor.id, reg);
    this.emit({ type: 'registered', providerId: descriptor.id });
    this.logger.info(`Registered sync provider ${descriptor.id}`, { source });
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.registrations.get(descriptor.id) === reg) {
          this.registrations.delete(descriptor.id);
          this.emit({ type: 'unregistered', providerId: descriptor.id });
        }
      },
    };
  }

  has(providerId: string): boolean {
    return this.registrations.has(providerId);
  }

  get(providerId: string): SyncProviderDescriptor | undefined {
    return this.registrations.get(providerId)?.descriptor;
  }

  list(): SyncProviderDescriptor[] {
    return [...this.registrations.values()].map((r) => r.descriptor).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  onDidChange(listener: (e: RegistryChangeEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private emit(e: RegistryChangeEvent) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* ignore */
      }
    }
  }

  /** Secret scope of one instance (used by the host's configuration UI to store `secret` fields). */
  secretsFor(instanceId: string): ScopedSecretStorage {
    return createScopedSecrets(this.options.vault, instanceId);
  }

  /** Remove all declared secret fields of an instance (when the user removes the provider). */
  async deleteInstanceSecrets(instanceId: string, providerId: string): Promise<void> {
    const d = this.get(providerId);
    const secrets = this.secretsFor(instanceId);
    for (const f of d?.configSchema ?? []) if (f.type === 'secret') await secrets.delete(f.key);
  }

  /** Validate configuration (including presence of required secrets) without creating an instance. */
  async validateInstanceConfig(providerId: string, instanceId: string, config: Record<string, unknown>) {
    const d = this.get(providerId);
    if (!d) throw new ReqvynError('NOT_FOUND', `Sync provider "${providerId}" is not registered`);
    const secrets = this.secretsFor(instanceId);
    const present = new Set<string>();
    for (const f of d.configSchema) if (f.type === 'secret' && (await secrets.get(f.key)) !== undefined) present.add(f.key);
    return validateConfigValues(d.configSchema, config, present);
  }

  /** Create and initialize a guarded provider instance. */
  async createInstance(opts: ProviderInstanceOptions): Promise<GuardedSyncProvider> {
    const reg = this.registrations.get(opts.providerId);
    if (!reg) throw new ReqvynError('NOT_FOUND', `Sync provider "${opts.providerId}" is not registered`);
    if (!INSTANCE_ID_RE.test(opts.instanceId)) throw new ReqvynError('VALIDATION', `Invalid provider instance id "${opts.instanceId}"`);
    const { values, issues } = await this.validateInstanceConfig(opts.providerId, opts.instanceId, opts.config ?? {});
    if (issues.length) {
      throw new SyncProviderError('CONFIG', `Invalid configuration: ${issues.map((i) => i.message).join('; ')}`, { details: { issues } });
    }
    let inner: SyncProvider;
    try {
      inner = reg.factory.create();
    } catch (e) {
      throw toSyncProviderError(e, `${reg.descriptor.displayName}: create() failed`);
    }
    if (!inner || typeof inner.pull !== 'function' || typeof inner.push !== 'function' || typeof inner.initialize !== 'function') {
      throw new SyncProviderError('INTERNAL', `${reg.descriptor.displayName}: create() did not return a SyncProvider`);
    }
    if (inner.id !== reg.descriptor.id) {
      throw new SyncProviderError('INTERNAL', `Provider id "${String(inner.id)}" does not match descriptor id "${reg.descriptor.id}"`);
    }
    const abort = new AbortController();
    const guarded = new GuardedSyncProvider(inner, abort, reg.descriptor.capabilities);
    const context: SyncProviderContext = Object.freeze({
      instanceId: opts.instanceId,
      config: values,
      secrets: this.secretsFor(opts.instanceId),
      logger: safeLogger(this.logger, `${reg.descriptor.id}/${opts.instanceId}`),
      signal: abort.signal,
      progress: safeProgress(opts.progress),
      storagePath: opts.storagePath,
    });
    try {
      await guarded.initialize(context);
    } catch (e) {
      await guarded.dispose();
      throw e;
    }
    return guarded;
  }
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
