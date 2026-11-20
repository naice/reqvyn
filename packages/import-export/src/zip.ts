import { ReqvynError } from '@reqvyn/shared';
import { Inflate } from 'fflate';

/**
 * Safe, in-memory ZIP reader. The central directory is parsed by hand so that every entry is
 * validated (path, declared sizes, compression ratio, count) BEFORE any data is inflated; actual
 * sizes are then enforced while inflating (in small chunks) and checked against a CRC-32.
 * Nothing is ever written to disk.
 */

export interface ZipLimits {
  /** Maximum number of entries (files + directories). Default 5000. */
  maxEntries: number;
  /** Maximum total uncompressed size. Default 50 MB. */
  maxTotalBytes: number;
  /** Maximum uncompressed size of a single entry. Default 20 MB. */
  maxEntryBytes: number;
  /** Maximum uncompressed/compressed ratio for entries larger than 1 MB. Default 200. */
  maxCompressionRatio: number;
  /** Maximum archive size. Default 100 MB. */
  maxArchiveBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 5000,
  maxTotalBytes: 50 * 1024 * 1024,
  maxEntryBytes: 20 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxArchiveBytes: 100 * 1024 * 1024,
};

const RATIO_THRESHOLD = 1024 * 1024;

function untrusted(message: string, details?: Record<string, unknown>): ReqvynError {
  return new ReqvynError('UNTRUSTED', message, { ...(details ? { details } : {}), hint: 'The package may be corrupted or malicious. Only import packages from sources you trust.' });
}

function tooLarge(message: string, details?: Record<string, unknown>): ReqvynError {
  return new ReqvynError('TOO_LARGE', message, details ? { details } : {});
}

let CRC_TABLE: Uint32Array | undefined;
export function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = (CRC_TABLE[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Validate an archive entry name; rejects absolute paths, traversal, backslashes and drive letters (zip-slip). */
export function validateEntryPath(name: string): string {
  if (!name) throw untrusted('Archive contains an entry with an empty name.');
  if (name.includes('\\')) throw untrusted(`Archive entry "${name}" contains a backslash.`, { entry: name });
  if (/^[A-Za-z]:/.test(name)) throw untrusted(`Archive entry "${name}" uses a drive letter.`, { entry: name });
  if (name.startsWith('/')) throw untrusted(`Archive entry "${name}" is an absolute path.`, { entry: name });
  if (/[\u0000-\u001f\u007f]/.test(name)) throw untrusted(`Archive entry "${name}" contains control characters.`, { entry: name });
  const segments = name.replace(/\/$/, '').split('/');
  for (const s of segments) {
    if (s === '..' || s === '.') throw untrusted(`Archive entry "${name}" contains a "${s}" path segment.`, { entry: name });
    if (s === '') throw untrusted(`Archive entry "${name}" contains an empty path segment.`, { entry: name });
  }
  if (name.length > 512) throw untrusted('Archive entry name is too long.', { entry: name.slice(0, 80) });
  return name;
}

interface CentralEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function inflateLimited(data: Uint8Array, limit: number, name: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inf = new Inflate((chunk) => {
    total += chunk.length;
    if (total > limit) throw tooLarge(`Archive entry "${name}" inflates beyond its allowed size (${limit} bytes).`, { entry: name });
    chunks.push(chunk);
  });
  const STEP = 1024;
  for (let i = 0; i < data.length; i += STEP) inf.push(data.subarray(i, Math.min(i + STEP, data.length)), i + STEP >= data.length);
  if (data.length === 0) inf.push(new Uint8Array(0), true);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Extract all file entries into memory. Throws ReqvynError (UNTRUSTED / TOO_LARGE / VALIDATION) on
 * any violation; never returns partial results.
 */
export function safeUnzip(bytes: Uint8Array, limitsIn: Partial<ZipLimits> = {}): Map<string, Uint8Array> {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...limitsIn };
  if (bytes.length > limits.maxArchiveBytes) throw tooLarge(`Archive is larger than ${limits.maxArchiveBytes} bytes.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Locate the End Of Central Directory record.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ReqvynError('VALIDATION', 'Not a ZIP archive (end of central directory not found).');
  const diskEntries = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw untrusted('ZIP64 archives are not supported.');
  if (diskEntries !== totalEntries || view.getUint16(eocd + 4, true) !== 0) throw untrusted('Multi-disk archives are not supported.');
  if (totalEntries > limits.maxEntries) throw tooLarge(`Archive has ${totalEntries} entries (limit ${limits.maxEntries}).`, { entries: totalEntries });
  if (cdOffset + cdSize > eocd) throw untrusted('Corrupt archive: central directory out of bounds.');

  const entries: CentralEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (p + 46 > eocd || view.getUint32(p, true) !== 0x02014b50) throw untrusted('Corrupt archive: bad central directory entry.');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    if (p + 46 + nameLen > eocd) throw untrusted('Corrupt archive: entry name out of bounds.');
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    } catch {
      throw untrusted('Archive entry name is not valid UTF-8.');
    }
    entries.push({ name, flags, method, crc, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
    if (entries.length > limits.maxEntries) throw tooLarge('Too many archive entries.');
  }

  // Validate everything before inflating anything.
  const seen = new Set<string>();
  let declaredTotal = 0;
  for (const e of entries) {
    validateEntryPath(e.name);
    const key = e.name.toLowerCase().replace(/\/$/, '');
    if (seen.has(key)) throw untrusted(`Archive contains duplicate entry "${e.name}".`, { entry: e.name });
    seen.add(key);
    if (e.flags & 0x1) throw untrusted(`Archive entry "${e.name}" is encrypted.`, { entry: e.name });
    if (e.method !== 0 && e.method !== 8) throw untrusted(`Archive entry "${e.name}" uses unsupported compression method ${e.method}.`, { entry: e.name });
    if (e.size > limits.maxEntryBytes) throw tooLarge(`Archive entry "${e.name}" is ${e.size} bytes (limit ${limits.maxEntryBytes}).`, { entry: e.name });
    declaredTotal += e.size;
    if (declaredTotal > limits.maxTotalBytes) throw tooLarge(`Archive content exceeds ${limits.maxTotalBytes} bytes.`);
    if (e.size > RATIO_THRESHOLD && e.size / Math.max(1, e.compressedSize) > limits.maxCompressionRatio)
      throw untrusted(`Archive entry "${e.name}" has a suspicious compression ratio (possible zip bomb).`, { entry: e.name });
    if (e.method === 0 && e.size !== e.compressedSize) throw untrusted(`Stored entry "${e.name}" has inconsistent sizes.`, { entry: e.name });
  }

  const out = new Map<string, Uint8Array>();
  let actualTotal = 0;
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    const lo = e.localOffset;
    if (lo + 30 > bytes.length || view.getUint32(lo, true) !== 0x04034b50) throw untrusted(`Corrupt archive: bad local header for "${e.name}".`);
    const lNameLen = view.getUint16(lo + 26, true);
    const lExtraLen = view.getUint16(lo + 28, true);
    let localName = '';
    try {
      localName = decoder.decode(bytes.subarray(lo + 30, lo + 30 + lNameLen));
    } catch {
      /* handled below */
    }
    if (localName !== e.name) throw untrusted(`Archive entry name mismatch between local and central headers ("${e.name}").`);
    const start = lo + 30 + lNameLen + lExtraLen;
    const end = start + e.compressedSize;
    if (end > bytes.length) throw untrusted(`Corrupt archive: data of "${e.name}" out of bounds.`);
    const raw = bytes.subarray(start, end);
    const limit = Math.min(e.size, limits.maxEntryBytes, limits.maxTotalBytes - actualTotal);
    const data = e.method === 0 ? raw.slice() : inflateLimited(raw, limit, e.name);
    if (data.length !== e.size) throw untrusted(`Archive entry "${e.name}" size does not match its declared size.`, { entry: e.name });
    if (crc32(data) !== e.crc) throw untrusted(`Archive entry "${e.name}" failed its CRC check.`, { entry: e.name });
    actualTotal += data.length;
    out.set(e.name, data);
  }
  return out;
}
