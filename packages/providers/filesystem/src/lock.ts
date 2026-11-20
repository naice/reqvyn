import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SyncProviderError, delay, throwIfCancelled } from '@reqvyn/provider-sdk';

export interface FileLockOptions {
  /** Give up after this long (default 10 s) with a retryable `UNAVAILABLE` error. */
  timeoutMs?: number;
  /** A lock whose heartbeat is older than this is considered stale (default 30 s). */
  staleMs?: number;
  /** Poll interval while waiting (default 50 ms, jittered). */
  retryDelayMs?: number;
  signal?: AbortSignal;
}

interface LockInfo {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readInfo(lockPath: string): Promise<LockInfo | null> {
  try {
    return JSON.parse(await fs.readFile(lockPath, 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

/**
 * Cross-process / cross-machine exclusive lock based on exclusive file creation (`O_EXCL`), which
 * also works on SMB/NFS shares and USB drives. The holder refreshes the lock's mtime (heartbeat);
 * a lock is stale when its heartbeat is older than `staleMs`, or when it was created on this host
 * by a process that no longer exists. Stale locks are broken by renaming them away first, so only
 * one waiter can break a given lock.
 */
export class FileLock {
  private released = false;

  private constructor(
    readonly lockPath: string,
    readonly token: string,
    private readonly heartbeat: ReturnType<typeof setInterval>,
  ) {}

  static async acquire(lockPath: string, options: FileLockOptions = {}): Promise<FileLock> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const staleMs = options.staleMs ?? 30_000;
    const retryDelay = options.retryDelayMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    const token = randomBytes(12).toString('hex');
    const info: LockInfo = { token, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() };
    for (;;) {
      throwIfCancelled(options.signal);
      try {
        const handle = await fs.open(lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify(info));
          await handle.sync();
        } finally {
          await handle.close();
        }
        const beat = setInterval(
          () => {
            const now = new Date();
            void fs.utimes(lockPath, now, now).catch(() => undefined);
          },
          Math.max(250, Math.floor(staleMs / 3)),
        );
        beat.unref?.();
        return new FileLock(lockPath, token, beat);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          await fs.mkdir(path.dirname(lockPath), { recursive: true });
          continue;
        }
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') throw e;
      }
      if (await FileLock.isStale(lockPath, staleMs)) {
        await FileLock.breakLock(lockPath);
        continue;
      }
      if (Date.now() >= deadline) {
        const holder = await readInfo(lockPath);
        throw new SyncProviderError('UNAVAILABLE', 'The sync folder is locked by another writer', {
          details: { lockPath, holderHost: holder?.hostname, holderPid: holder?.pid, since: holder?.createdAt },
        });
      }
      await delay(retryDelay + Math.floor(Math.random() * retryDelay), options.signal);
    }
  }

  /** True if the lock at `lockPath` is abandoned. */
  static async isStale(lockPath: string, staleMs: number): Promise<boolean> {
    let stat;
    try {
      stat = await fs.stat(lockPath);
    } catch {
      return false; // vanished – the next create attempt will succeed
    }
    if (Date.now() - stat.mtimeMs > staleMs) return true;
    const info = await readInfo(lockPath);
    if (info && info.hostname === os.hostname() && info.pid !== process.pid && !pidAlive(info.pid)) return true;
    return false;
  }

  private static async breakLock(lockPath: string): Promise<void> {
    const aside = `${lockPath}.stale-${randomBytes(4).toString('hex')}`;
    try {
      await fs.rename(lockPath, aside);
    } catch {
      return; // someone else broke (or released) it
    }
    await fs.rm(aside, { force: true }).catch(() => undefined);
  }

  /** Run `fn` while holding the lock. */
  static async with<T>(lockPath: string, fn: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
    const lock = await FileLock.acquire(lockPath, options);
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    clearInterval(this.heartbeat);
    const info = await readInfo(this.lockPath);
    if (info?.token === this.token) await fs.rm(this.lockPath, { force: true });
  }
}
