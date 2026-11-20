import type { Collection, CollectionStore } from '@reqvyn/core';
import { ReqvynError, isReqvynError, retryWithBackoff, throwIfAborted } from '@reqvyn/shared';
import {
  emptySnapshot,
  isRetryable,
  isSyncProviderError,
  toSyncProviderError,
  validateSnapshot,
  type SyncLogger,
  type SyncProgress,
  type SyncProvider,
  type SyncSnapshot,
  type SyncTombstone,
} from '@reqvyn/provider-sdk';
import { collectionToSnapshot, snapshotToCollection } from './convert.js';
import {
  hasChanges,
  mergeSnapshots,
  rebaseAfterPull,
  type ChangeSet,
  type ConflictDecision,
  type MergeWarning,
  type SyncConflict,
} from './merge.js';
import { noopLogger } from './registry.js';
import { initialSyncState, type SyncErrorInfo, type SyncRunStatus, type SyncState, type SyncStateStore } from './state.js';

/** Minimal access to the local collection copy. `save` must persist the collection exactly as given. */
export interface LocalCollectionAccess {
  load(collectionId: string): Promise<Collection | null>;
  save(collection: Collection): Promise<void>;
}

/** Adapter for a `CollectionStore` from `@reqvyn/core`. */
export function collectionStoreAccess(store: Pick<CollectionStore, 'loadCollection' | 'saveCollection'>): LocalCollectionAccess {
  return {
    async load(id) {
      try {
        return await store.loadCollection(id);
      } catch (e) {
        if (isReqvynError(e) && e.code === 'NOT_FOUND') return null;
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw e;
      }
    },
    save: (c) => store.saveCollection(c),
  };
}

export type SyncMode = 'bidirectional' | 'pull' | 'push';

export interface SyncEngineOptions {
  provider: SyncProvider;
  /** Provider instance id (sync state is kept per instance + collection). */
  instanceId: string;
  local: LocalCollectionAccess;
  stateStore: SyncStateStore;
  /** Retry policy for retryable provider errors and push conflicts (re-pull + merge). */
  retry?: { retries?: number; baseDelayMs?: number; maxDelayMs?: number };
  tombstoneMaxAgeMs?: number;
  now?: () => Date;
  logger?: SyncLogger;
  onProgress?: (progress: SyncProgress) => void;
}

export interface SyncRunOptions {
  mode?: SyncMode;
  signal?: AbortSignal;
  onProgress?: (progress: SyncProgress) => void;
  /** Decisions for conflicts reported by a previous run (see `SyncEngine.resolveConflicts`). */
  decisions?: Record<string, ConflictDecision>;
}

export interface SyncRunResult {
  collectionId: string;
  mode: SyncMode;
  status: SyncRunStatus;
  /** Remote revision after the run (if known). */
  revision: string | null;
  conflicts: SyncConflict[];
  warnings: MergeWarning[];
  /** Changes applied to the local collection. */
  localChanges: ChangeSet;
  /** Changes pushed to the remote. */
  remoteChanges: ChangeSet;
  pushed: boolean;
  appliedLocally: boolean;
  autoMerged: string[];
  resolved: string[];
  /** Decision ids ignored because the conflict changed (or vanished) since it was reported. */
  staleDecisions: string[];
  attempts: number;
  durationMs: number;
  error?: SyncErrorInfo;
}

class PushConflict extends Error {
  constructor(readonly remoteRevision: string | null) {
    super('Remote changed during synchronization');
    this.name = 'PushConflict';
  }
}

const EMPTY_CHANGES: ChangeSet = { added: [], updated: [], deleted: [] };

/**
 * Local snapshot for a merge: the collection's entities plus tombstones for everything the base
 * had that is now gone locally (local deletions are detected against the last synced state).
 */
export function deriveLocalSnapshot(collection: Collection, base: SyncSnapshot | null, now: Date = new Date()): SyncSnapshot {
  const snap = collectionToSnapshot(collection);
  const tombs = new Map<string, SyncTombstone>();
  for (const t of base?.tombstones ?? []) if (!snap.entities[t.id]) tombs.set(t.id, t);
  for (const [id, e] of Object.entries(base?.entities ?? {})) {
    if (!snap.entities[id]) {
      tombs.set(id, { id, kind: e.kind, deletedAt: now.toISOString(), revisionAt: base?.revision ?? null, lastHash: e.hash });
    }
  }
  return { ...snap, tombstones: [...tombs.values()].sort((a, b) => (a.id < b.id ? -1 : 1)) };
}

function toErrorInfo(e: unknown): SyncErrorInfo {
  if (e instanceof PushConflict) {
    return { code: 'CONFLICT', message: 'The remote kept changing during synchronization; please try again.', retryable: true };
  }
  if (isSyncProviderError(e)) return { code: e.code, message: e.message, retryable: e.retryable, details: e.details };
  if (isReqvynError(e)) {
    return { code: e.code === 'CANCELLED' ? 'CANCELLED' : e.code, message: e.message, retryable: false, details: e.details };
  }
  const p = toSyncProviderError(e);
  return { code: p.code, message: p.message, retryable: p.retryable };
}

function isCancellation(e: unknown): boolean {
  if (isReqvynError(e)) return e.code === 'CANCELLED';
  return toSyncProviderError(e).code === 'CANCELLED';
}

function entityHash(e: { hash: string } | null | undefined): string | null {
  return e?.hash ?? null;
}

/**
 * Orchestrates pull → merge → apply → push for one provider instance.
 *
 * Guarantees:
 * - Divergent data is never overwritten: concurrent edits merge only when field-disjoint,
 *   otherwise the run stops with `conflicts` and nothing is pushed.
 * - Pushes are conditional on the pulled revision (optimistic concurrency); a lost race re-pulls,
 *   re-merges and retries with exponential backoff.
 * - The merge base only advances after a successful push / complete pull, so offline edits and
 *   failed runs are simply picked up by the next run.
 */
export class SyncEngine {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly logger: SyncLogger;

  constructor(private readonly options: SyncEngineOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  get provider(): SyncProvider {
    return this.options.provider;
  }

  sync(collectionId: string, options: SyncRunOptions = {}): Promise<SyncRunResult> {
    return this.exclusive(collectionId, () => this.run(collectionId, options));
  }

  pull(collectionId: string, options: Omit<SyncRunOptions, 'mode'> = {}): Promise<SyncRunResult> {
    return this.sync(collectionId, { ...options, mode: 'pull' });
  }

  push(collectionId: string, options: Omit<SyncRunOptions, 'mode'> = {}): Promise<SyncRunResult> {
    return this.sync(collectionId, { ...options, mode: 'push' });
  }

  /**
   * Resolve conflicts reported by the previous run: `local` keeps the local version (or deletion),
   * `remote` takes the remote version, `merged` stores `mergedData`. Re-pulls first; a decision whose
   * conflict changed in the meantime is ignored (reported in `staleDecisions`).
   */
  resolveConflicts(
    collectionId: string,
    decisions: Record<string, ConflictDecision>,
    options: Omit<SyncRunOptions, 'decisions'> = {},
  ): Promise<SyncRunResult> {
    return this.sync(collectionId, { ...options, decisions });
  }

  async getState(collectionId: string): Promise<SyncState> {
    return (await this.options.stateStore.load(this.options.instanceId, collectionId)) ?? initialSyncState(this.options.instanceId, collectionId);
  }

  async getPendingConflicts(collectionId: string): Promise<SyncConflict[]> {
    return (await this.getState(collectionId)).pendingConflicts;
  }

  /** Forget sync state (e.g. when a collection is unassigned from the provider). */
  async forget(collectionId: string): Promise<void> {
    await this.options.stateStore.delete(this.options.instanceId, collectionId);
  }

  private exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return next;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private emit(options: SyncRunOptions, p: SyncProgress) {
    for (const fn of [this.options.onProgress, options.onProgress]) {
      try {
        fn?.(p);
      } catch {
        /* ignore */
      }
    }
  }

  private async run(collectionId: string, options: SyncRunOptions): Promise<SyncRunResult> {
    const started = Date.now();
    const { provider, stateStore, instanceId } = this.options;
    let state = (await stateStore.load(instanceId, collectionId)) ?? initialSyncState(instanceId, collectionId);
    let mode: SyncMode = options.mode ?? 'bidirectional';
    const requestedMode = mode;
    const warnings: MergeWarning[] = [];
    let attempts = 0;
    const base = (): SyncRunResult => ({
      collectionId,
      mode: requestedMode,
      status: 'failed',
      revision: state.lastRevision,
      conflicts: [],
      warnings,
      localChanges: EMPTY_CHANGES,
      remoteChanges: EMPTY_CHANGES,
      pushed: false,
      appliedLocally: false,
      autoMerged: [],
      resolved: [],
      staleDecisions: [],
      attempts,
      durationMs: Date.now() - started,
    });

    try {
      if (!provider.capabilities.read) throw new ReqvynError('SYNC', `${provider.displayName} cannot read collections`);
      if (mode !== 'pull' && !provider.capabilities.write) {
        if (mode === 'push') throw new ReqvynError('SYNC', `${provider.displayName} is read-only`);
        mode = 'pull';
        warnings.push({ id: collectionId, message: 'Provider is read-only; only pulling.' });
      }
      const retry = this.options.retry ?? {};
      const result = await retryWithBackoff(
        async (attempt) => {
          attempts = attempt + 1;
          return this.attempt(collectionId, mode, state, options, warnings);
        },
        {
          retries: retry.retries ?? 3,
          baseDelayMs: retry.baseDelayMs ?? 500,
          maxDelayMs: retry.maxDelayMs ?? 10_000,
          signal: options.signal,
          shouldRetry: (e) => e instanceof PushConflict || (!isCancellation(e) && !isReqvynError(e) && isRetryable(e)),
          onRetry: (e, n, delayMs) => {
            this.logger.warn(`Sync attempt failed, retrying (${n})`, { error: toErrorInfo(e), delayMs });
            this.emit(options, { phase: 'retry', collectionId, message: `Retrying in ${delayMs} ms (${toErrorInfo(e).message})` });
          },
        },
      );
      state = result.state;
      this.emit(options, { phase: 'done', collectionId, message: result.result.status });
      return { ...result.result, mode: requestedMode, attempts, durationMs: Date.now() - started };
    } catch (e) {
      const cancelled = isCancellation(e);
      const error = cancelled ? { code: 'CANCELLED', message: 'Synchronization cancelled', retryable: false } : toErrorInfo(e);
      if (!cancelled) this.logger.error('Synchronization failed', { collectionId, error });
      const failed: SyncState = {
        ...state,
        lastAttemptAt: this.now().toISOString(),
        lastStatus: cancelled ? 'cancelled' : 'failed',
        lastError: error,
      };
      try {
        await stateStore.save(failed);
      } catch (saveError) {
        this.logger.error('Could not persist sync state', { error: String(saveError) });
      }
      this.emit(options, { phase: 'done', collectionId, message: failed.lastStatus });
      return { ...base(), status: cancelled ? 'cancelled' : 'failed', error, attempts };
    }
  }

  private async attempt(
    collectionId: string,
    mode: SyncMode,
    state: SyncState,
    options: SyncRunOptions,
    warnings: MergeWarning[],
  ): Promise<{ state: SyncState; result: SyncRunResult }> {
    const { provider, local, stateStore } = this.options;
    const signal = options.signal;
    const progress = { report: (p: SyncProgress) => this.emit(options, { collectionId, ...p }) };
    const now = this.now();
    throwIfAborted(signal);

    this.emit(options, { phase: 'pull', collectionId, message: 'Reading remote collection' });
    const localCollection = await local.load(collectionId);
    if (!localCollection && mode === 'push') throw new ReqvynError('NOT_FOUND', `Collection ${collectionId} does not exist locally`);
    const localSnap = localCollection ? deriveLocalSnapshot(localCollection, state.base, now) : emptySnapshot(collectionId);

    let remote: SyncSnapshot | null;
    try {
      const pulled = await provider.pull(collectionId, { signal, progress });
      remote = pulled ? validateSnapshot(pulled, { collectionId }) : null;
    } catch (e) {
      if (isSyncProviderError(e) && e.code === 'NOT_FOUND') remote = null;
      else throw e;
    }
    throwIfAborted(signal);

    this.emit(options, { phase: 'merge', collectionId });
    const mergeOptions = { now, tombstoneMaxAgeMs: this.options.tombstoneMaxAgeMs };
    const input = { base: state.base, local: localSnap, remote };
    let decisions: Record<string, ConflictDecision> | undefined;
    const staleDecisions: string[] = [];
    if (options.decisions && Object.keys(options.decisions).length) {
      const probe = mergeSnapshots(input, mergeOptions);
      decisions = {};
      for (const [id, d] of Object.entries(options.decisions)) {
        const current = probe.conflicts.find((c) => c.id === id);
        const pending = state.pendingConflicts.find((c) => c.id === id);
        const fresh =
          current &&
          (!pending || (entityHash(pending.local) === entityHash(current.local) && entityHash(pending.remote) === entityHash(current.remote)));
        if (fresh) decisions[id] = d;
        else staleDecisions.push(id);
      }
    }
    const merge = mergeSnapshots(input, { ...mergeOptions, decisions });
    const runWarnings = [...warnings, ...merge.warnings];
    const result = (status: SyncRunStatus, extra: Partial<SyncRunResult>): SyncRunResult => ({
      collectionId,
      mode,
      status,
      revision: remote?.revision ?? state.lastRevision,
      conflicts: merge.conflicts,
      warnings: runWarnings,
      localChanges: EMPTY_CHANGES,
      remoteChanges: EMPTY_CHANGES,
      pushed: false,
      appliedLocally: false,
      autoMerged: merge.autoMerged,
      resolved: merge.resolved,
      staleDecisions,
      attempts: 0,
      durationMs: 0,
      ...extra,
    });
    const saveLocal = async () => {
      this.emit(options, { phase: 'apply', collectionId, message: 'Updating local collection' });
      await local.save(snapshotToCollection(merge.merged));
    };
    const nowIso = now.toISOString();

    // ---- Conflicts: apply only the safe (non-conflicting) remote changes, never push. ----
    if (merge.conflicts.length) {
      let applied = false;
      let nextBase = state.base;
      if (mode !== 'push' && remote) {
        if (hasChanges(merge.localChanges)) {
          await saveLocal();
          applied = true;
        }
        nextBase = rebaseAfterPull(state.base, remote, merge.conflicts.map((c) => c.id));
      }
      const next: SyncState = {
        ...state,
        base: nextBase,
        lastRevision: remote?.revision ?? state.lastRevision,
        lastAttemptAt: nowIso,
        lastStatus: 'conflicts',
        lastError: null,
        pendingConflicts: merge.conflicts,
      };
      await stateStore.save(next);
      return { state: next, result: result('conflicts', { appliedLocally: applied, localChanges: applied ? merge.localChanges : EMPTY_CHANGES }) };
    }

    // ---- Push-only: refuse if the remote has changes we have not pulled. ----
    if (mode === 'push' && hasChanges(merge.localChanges)) {
      const next: SyncState = { ...state, lastAttemptAt: nowIso, lastStatus: 'remote-ahead', lastError: null };
      await stateStore.save(next);
      return { state: next, result: result('remote-ahead', {}) };
    }

    // ---- Pull-only ----
    if (mode === 'pull') {
      let applied = false;
      let nextBase = state.base;
      if (remote) {
        if (hasChanges(merge.localChanges)) {
          await saveLocal();
          applied = true;
        }
        nextBase = rebaseAfterPull(state.base, remote, []);
      }
      const next: SyncState = {
        ...state,
        base: nextBase,
        lastRevision: remote?.revision ?? state.lastRevision,
        lastSyncAt: nowIso,
        lastAttemptAt: nowIso,
        lastStatus: applied ? 'synced' : 'up-to-date',
        lastError: null,
        pendingConflicts: [],
      };
      await stateStore.save(next);
      return { state: next, result: result(next.lastStatus as SyncRunStatus, { appliedLocally: applied, localChanges: applied ? merge.localChanges : EMPTY_CHANGES }) };
    }

    // ---- Bidirectional / push ----
    let revision = remote?.revision ?? null;
    let pushed = false;
    const needsPush = remote ? hasChanges(merge.remoteChanges) : Object.keys(merge.merged.entities).length > 0;
    if (needsPush) {
      throwIfAborted(signal);
      if (remote && !provider.capabilities.optimisticConcurrency) {
        // Best effort for providers without conditional writes: narrow the race window.
        const manifest = await provider.getRemoteManifest(collectionId, { signal });
        if ((manifest?.revision ?? null) !== remote.revision) throw new PushConflict(manifest?.revision ?? null);
      }
      this.emit(options, { phase: 'push', collectionId, message: 'Uploading changes' });
      const res = await provider.push(collectionId, merge.merged, remote ? remote.revision : null, { signal, progress });
      if (res.status === 'conflict') throw new PushConflict(res.remoteRevision);
      revision = res.revision;
      pushed = true;
    }
    let applied = false;
    if (mode !== 'push' && hasChanges(merge.localChanges)) {
      await saveLocal();
      applied = true;
    }
    const nextBase: SyncSnapshot | null = revision || pushed ? { ...merge.merged, revision } : state.base;
    const status: SyncRunStatus = pushed || applied ? 'synced' : 'up-to-date';
    const next: SyncState = {
      ...state,
      base: nextBase,
      lastRevision: revision,
      lastSyncAt: nowIso,
      lastAttemptAt: nowIso,
      lastStatus: status,
      lastError: null,
      pendingConflicts: [],
    };
    await stateStore.save(next);
    return {
      state: next,
      result: result(status, {
        revision,
        pushed,
        appliedLocally: applied,
        localChanges: applied ? merge.localChanges : EMPTY_CHANGES,
        remoteChanges: pushed ? (remote ? merge.remoteChanges : { added: Object.keys(merge.merged.entities).sort(), updated: [], deleted: [] }) : EMPTY_CHANGES,
      }),
    };
  }
}
