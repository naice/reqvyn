import { promises as fs, constants as fsConstants } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ReqvynError, sleep } from '@reqvyn/shared';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

/** Retry an fs operation that can fail transiently on Windows (virus scanners, indexers, open handles). */
export async function retryFs<T>(op: () => Promise<T>, attempts = 8): Promise<T> {
  let delay = 15;
  for (let i = 0; ; i++) {
    try {
      return await op();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (i >= attempts - 1 || !RETRYABLE.has(code)) throw e;
      await sleep(delay);
      delay = Math.min(delay * 2, 500);
    }
  }
}

export const TMP_SUFFIX = '.reqvyn-tmp';

/**
 * Atomic write: write to a temp file in the same directory, fsync, then rename over the target.
 * Readers never observe a partially written file.
 */
export async function atomicWriteFile(file: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${randomBytes(4).toString('hex')}${TMP_SUFFIX}`);
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await retryFs(() => fs.rename(tmp, file));
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw new ReqvynError('IO', `Could not write ${file}: ${(e as Error).message}`, { cause: e });
  }
}

export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ReqvynError('IO', `Could not read ${file}: ${(e as Error).message}`, { cause: e });
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function removeFile(file: string): Promise<void> {
  await retryFs(() => fs.rm(file, { force: true }));
}

export async function removeDir(dir: string): Promise<void> {
  await retryFs(() => fs.rm(dir, { recursive: true, force: true }));
}

export async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('.')).map((e) => join(dir, e.name));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => join(dir, e.name));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * Cross-process advisory lock based on an exclusively-created lock file. Protects multi-file
 * write batches when two VS Code windows (or the CLI) operate on the same workspace.
 * Locks older than `staleMs` are considered abandoned (crashed process) and are broken.
 */
export class FileLock {
  constructor(
    private readonly file: string,
    private readonly opts: { staleMs?: number; timeoutMs?: number } = {},
  ) {}

  async acquire(): Promise<() => Promise<void>> {
    const staleMs = this.opts.staleMs ?? 15_000;
    const deadline = Date.now() + (this.opts.timeoutMs ?? 10_000);
    const token = `${process.pid}:${randomBytes(6).toString('hex')}`;
    await fs.mkdir(dirname(this.file), { recursive: true });
    for (;;) {
      try {
        const h = await fs.open(this.file, 'wx');
        await h.writeFile(JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
        await h.close();
        return async () => {
          const current = await readTextIfExists(this.file);
          if (current && current.includes(token)) await removeFile(this.file).catch(() => undefined);
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new ReqvynError('IO', `Cannot create lock ${this.file}`, { cause: e });
        try {
          const st = await fs.stat(this.file);
          if (Date.now() - st.mtimeMs > staleMs) {
            await removeFile(this.file);
            continue;
          }
        } catch {
          continue; // removed concurrently
        }
        if (Date.now() > deadline) {
          throw new ReqvynError('CONFLICT', 'The workspace storage is locked by another process.', {
            hint: `If no other REQVYN instance is running, delete ${this.file}.`,
          });
        }
        await sleep(25 + Math.random() * 50);
      }
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}

/** Serializes async tasks (in-process write queue). */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

