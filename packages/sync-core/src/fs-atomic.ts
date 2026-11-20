import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Atomically replace `file` with `data`: write a temp file in the same directory, fsync it and
 * rename it over the target. Readers see either the old or the new content, never a torn write.
 * Rename is retried briefly on Windows, where virus scanners / indexers hold transient handles.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
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
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 8 || !RENAME_RETRY_CODES.has(code)) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw e;
      }
      await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
    }
  }
}

/**
 * Reversible, file-name-safe encoding of an id: `[a-z0-9_-]` pass through, every other byte
 * becomes `~XX`. Lower-case only, so ids differing in case never collide on case-insensitive
 * file systems, and `.`/`..`/separators can never escape a directory.
 */
export function encodeFileName(id: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(id)) {
    const c = String.fromCharCode(byte);
    out += /[a-z0-9_-]/.test(c) ? c : `~${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}
