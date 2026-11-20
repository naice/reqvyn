import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** `fs.rename` with short retries for transient Windows sharing violations. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 8 || !RENAME_RETRY_CODES.has(code)) throw e;
      await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
    }
  }
}

/** Write `data` to a unique temp file next to `file` and fsync it. Returns the temp path. */
export async function writeTempFile(file: string, data: string | Uint8Array): Promise<string> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, 'wx');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return tmp;
}

/**
 * Atomically replace `file` (temp file + fsync + rename). Readers observe either the previous or
 * the new content, never a partially written file.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = await writeTempFile(file, data);
  try {
    await renameWithRetry(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/**
 * Reversible, file-name-safe encoding of an id: `[a-z0-9_-]` pass through, every other byte
 * becomes `~XX`. Lower-case only (safe on case-insensitive file systems); `.`, `..` and path
 * separators can never appear, so ids cannot escape their directory.
 */
export function encodeFileName(id: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(id)) {
    const c = String.fromCharCode(byte);
    out += /[a-z0-9_-]/.test(c) ? c : `~${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/** Inverse of {@link encodeFileName}. */
export function decodeFileName(name: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '~') {
      bytes.push(parseInt(name.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(name.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
