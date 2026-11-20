import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  SyncProviderError,
  throwIfCancelled,
  toSyncProviderError,
  type RemoteCollectionInfo,
  type SyncHealthResult,
  type SyncManifest,
  type SyncPushResult,
  type SyncSnapshot,
} from '@reqvyn/provider-sdk';
import { decodeFileName, encodeFileName } from './atomic.js';
import { FileLock, type FileLockOptions } from './lock.js';
import {
  LOCK_FILE,
  MANIFEST_FILE,
  cleanTempFiles,
  readCollectionDir,
  readManifest,
  recoverCollectionDir,
  removeCollectionFiles,
  writeCollectionDir,
  type WriteHooks,
} from './layout.js';

export interface FileSystemSyncStoreOptions {
  lock?: Omit<FileLockOptions, 'signal'>;
  /** Fault-injection hooks (tests). */
  hooks?: WriteHooks;
}

/**
 * A file-based remote rooted at a directory. All reads and writes of a collection happen under its
 * lock file; writes are journaled (see `layout.ts`) and conditional on the expected revision
 * (optimistic concurrency). The revision is the content hash of the stored snapshot.
 */
export class FileSystemSyncStore {
  constructor(
    readonly root: string,
    private readonly options: FileSystemSyncStoreOptions = {},
  ) {}

  collectionDir(collectionId: string): string {
    if (!collectionId) throw new SyncProviderError('INVALID_DATA', 'Empty collection id');
    return path.join(this.root, encodeFileName(collectionId));
  }

  /** Run `fn` holding the collection lock, after recovering any interrupted write. */
  async withCollectionLock<T>(collectionId: string, fn: (dir: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const dir = this.collectionDir(collectionId);
    await this.ensureRoot();
    await fs.mkdir(dir, { recursive: true });
    return FileLock.with(
      path.join(dir, LOCK_FILE),
      async () => {
        await recoverCollectionDir(dir);
        return fn(dir);
      },
      { ...this.options.lock, signal },
    );
  }

  private async ensureRoot(): Promise<void> {
    try {
      const st = await fs.stat(this.root);
      if (!st.isDirectory()) throw new SyncProviderError('CONFIG', `${this.root} is not a directory`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        // Only create the leaf: a missing parent usually means an unmounted share / unplugged drive.
        try {
          await fs.mkdir(this.root);
        } catch (e2) {
          throw mapFsError(e2, `Sync folder ${this.root} is not available`);
        }
        return;
      }
      throw mapFsError(e, `Sync folder ${this.root} is not available`);
    }
  }

  /** Read the manifest without locking (manifest.json is replaced atomically). */
  async readManifest(collectionId: string): Promise<SyncManifest | null> {
    try {
      return await readManifest(this.collectionDir(collectionId));
    } catch (e) {
      throw mapFsError(e, 'Could not read manifest');
    }
  }

  async readSnapshot(collectionId: string, signal?: AbortSignal): Promise<SyncSnapshot | null> {
    try {
      if (!(await this.exists(path.join(this.collectionDir(collectionId), MANIFEST_FILE)))) {
        await this.ensureRoot();
        // No manifest and no pending journal → collection does not exist; avoid taking the lock.
        if (!(await this.exists(path.join(this.collectionDir(collectionId), '.staging')))) return null;
      }
      return await this.withCollectionLock(collectionId, (dir) => readCollectionDir(dir, collectionId), signal);
    } catch (e) {
      throw mapFsError(e, 'Could not read collection');
    }
  }

  async writeSnapshot(collectionId: string, snapshot: SyncSnapshot, expectedRevision?: string | null, signal?: AbortSignal): Promise<SyncPushResult> {
    if (snapshot.collectionId !== collectionId) throw new SyncProviderError('INVALID_DATA', 'Snapshot collection id mismatch');
    try {
      return await this.withCollectionLock(
        collectionId,
        async (dir) => {
          const current = await readManifest(dir);
          if (expectedRevision !== undefined && (current?.revision ?? null) !== expectedRevision) {
            return { status: 'conflict', remoteRevision: current?.revision ?? null } as const;
          }
          throwIfCancelled(signal);
          const manifest = await writeCollectionDir(dir, snapshot, { hooks: this.options.hooks });
          await cleanTempFiles(dir);
          return { status: 'ok', revision: manifest.revision, updatedAt: manifest.updatedAt } as const;
        },
        signal,
      );
    } catch (e) {
      throw mapFsError(e, 'Could not write collection');
    }
  }

  async deleteCollection(collectionId: string, expectedRevision?: string | null, signal?: AbortSignal): Promise<void> {
    const dir = this.collectionDir(collectionId);
    try {
      await this.withCollectionLock(
        collectionId,
        async () => {
          const current = await readManifest(dir);
          if (expectedRevision !== undefined && (current?.revision ?? null) !== expectedRevision) {
            throw new SyncProviderError('CONFLICT', 'Remote collection changed; refusing to delete');
          }
          await removeCollectionFiles(dir);
        },
        signal,
      );
      await fs.rmdir(dir).catch(() => undefined);
    } catch (e) {
      throw mapFsError(e, 'Could not delete collection');
    }
  }

  async listCollections(): Promise<RemoteCollectionInfo[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw mapFsError(e, 'Could not list sync folder');
    }
    const out: RemoteCollectionInfo[] = [];
    for (const n of names.sort()) {
      if (n.startsWith('.')) continue;
      try {
        const m = await readManifest(path.join(this.root, n));
        if (m && encodeFileName(m.collectionId) === n) {
          out.push({ collectionId: m.collectionId, label: m.label, revision: m.revision, updatedAt: m.updatedAt });
        }
      } catch {
        /* skip unreadable entries */
      }
    }
    return out;
  }

  /** Probe that the folder exists (or can be created) and is writable. */
  async probe(): Promise<SyncHealthResult> {
    const started = Date.now();
    try {
      await this.ensureRoot();
      const probe = path.join(this.root, `.reqvyn-probe-${randomBytes(4).toString('hex')}`);
      await fs.writeFile(probe, 'ok');
      await fs.readFile(probe, 'utf8');
      await fs.rm(probe, { force: true });
      return { ok: true, message: `Folder ${this.root} is readable and writable`, latencyMs: Date.now() - started };
    } catch (e) {
      const err = mapFsError(e, 'Sync folder is not usable');
      return { ok: false, message: err.message, code: err.code, latencyMs: Date.now() - started };
    }
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
}

/** Map Node file-system errors to provider errors with a readable message. */
export function mapFsError(e: unknown, message: string): SyncProviderError {
  const err = toSyncProviderError(e, message);
  if (err === e) return err;
  if (err.code === 'NOT_FOUND') {
    // A missing path below an existing root usually means the share / drive went away.
    return new SyncProviderError('UNAVAILABLE', `${message}: ${err.message}`, { cause: e, details: err.details });
  }
  if (err.code === 'INTERNAL') return new SyncProviderError('INTERNAL', `${message}: ${err.message}`, { cause: e });
  return new SyncProviderError(err.code, `${message}: ${err.message}`, { cause: e, details: err.details, retryable: err.retryable });
}

export { decodeFileName };
