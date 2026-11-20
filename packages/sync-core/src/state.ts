import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { canonicalJson, stableStringify } from '@reqvyn/shared';
import { validateSnapshot, type SyncLogger, type SyncSnapshot } from '@reqvyn/provider-sdk';
import { encodeFileName, writeFileAtomic } from './fs-atomic.js';
import type { SyncConflict } from './merge.js';

export type SyncRunStatus = 'synced' | 'up-to-date' | 'conflicts' | 'remote-ahead' | 'failed' | 'cancelled';

/** Serializable error description stored in sync state and returned in results. */
export interface SyncErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/** Persistent synchronization state of one collection for one provider instance. */
export interface SyncState {
  version: 1;
  instanceId: string;
  collectionId: string;
  /** Last state known to be identical locally and remotely (merge base). */
  base: SyncSnapshot | null;
  /** Remote revision of the last successful pull/push. */
  lastRevision: string | null;
  lastSyncAt: string | null;
  lastAttemptAt: string | null;
  lastStatus: SyncRunStatus | 'never';
  lastError: SyncErrorInfo | null;
  /** Conflicts of the last run awaiting a user decision. */
  pendingConflicts: SyncConflict[];
}

export function initialSyncState(instanceId: string, collectionId: string): SyncState {
  return {
    version: 1,
    instanceId,
    collectionId,
    base: null,
    lastRevision: null,
    lastSyncAt: null,
    lastAttemptAt: null,
    lastStatus: 'never',
    lastError: null,
    pendingConflicts: [],
  };
}

export interface SyncStateStore {
  load(instanceId: string, collectionId: string): Promise<SyncState | null>;
  save(state: SyncState): Promise<void>;
  delete(instanceId: string, collectionId: string): Promise<void>;
  /** Collection ids with state for an instance. */
  list(instanceId: string): Promise<string[]>;
}

export class MemorySyncStateStore implements SyncStateStore {
  private readonly map = new Map<string, string>();
  private key(i: string, c: string) {
    return `${i}\u0000${c}`;
  }
  async load(instanceId: string, collectionId: string) {
    const raw = this.map.get(this.key(instanceId, collectionId));
    return raw ? (JSON.parse(raw) as SyncState) : null;
  }
  async save(state: SyncState) {
    this.map.set(this.key(state.instanceId, state.collectionId), canonicalJson(state));
  }
  async delete(instanceId: string, collectionId: string) {
    this.map.delete(this.key(instanceId, collectionId));
  }
  async list(instanceId: string) {
    return [...this.map.keys()].filter((k) => k.startsWith(`${instanceId}\u0000`)).map((k) => k.split('\u0000')[1]!);
  }
}

/**
 * File-based state store: `<dir>/<instance>/<collection>.json`, written atomically (tmp + rename).
 * A corrupted state file is quarantined (`*.corrupt-<ts>`) and treated as "never synced", which is
 * safe: without a base the merge reports concurrent differences as conflicts and never deletes.
 */
export class FileSyncStateStore implements SyncStateStore {
  constructor(
    readonly directory: string,
    private readonly logger?: SyncLogger,
  ) {}

  private file(instanceId: string, collectionId: string): string {
    return path.join(this.directory, encodeFileName(instanceId), `${encodeFileName(collectionId)}.json`);
  }

  async load(instanceId: string, collectionId: string): Promise<SyncState | null> {
    const file = this.file(instanceId, collectionId);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    try {
      const parsed = JSON.parse(raw) as SyncState;
      if (parsed.version !== 1 || parsed.instanceId !== instanceId || parsed.collectionId !== collectionId) throw new Error('state mismatch');
      return {
        ...initialSyncState(instanceId, collectionId),
        ...parsed,
        base: parsed.base ? validateSnapshot(parsed.base, { collectionId }) : null,
        pendingConflicts: Array.isArray(parsed.pendingConflicts) ? parsed.pendingConflicts : [],
      };
    } catch (e) {
      const quarantine = `${file}.corrupt-${Date.now()}`;
      await fs.rename(file, quarantine).catch(() => undefined);
      this.logger?.warn('Sync state was corrupted and has been reset', { file: quarantine, error: String(e) });
      return null;
    }
  }

  async save(state: SyncState): Promise<void> {
    await writeFileAtomic(this.file(state.instanceId, state.collectionId), stableStringify(state));
  }

  async delete(instanceId: string, collectionId: string): Promise<void> {
    await fs.rm(this.file(instanceId, collectionId), { force: true });
  }

  async list(instanceId: string): Promise<string[]> {
    const dir = path.join(this.directory, encodeFileName(instanceId));
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const n of names) {
      if (!n.endsWith('.json') || n.startsWith('.')) continue;
      const s = await this.load(instanceId, decodeFileName(n.slice(0, -5)));
      if (s) out.push(s.collectionId);
    }
    return out;
  }
}

function decodeFileName(name: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '~') {
      bytes.push(parseInt(name.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(name.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
