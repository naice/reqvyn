import {
  SCHEMA_VERSION,
  parseCollection,
  parseCollectionInfo,
  parseEnvironment,
  parseFolder,
  parseRequest,
  type Collection,
  type Environment,
  type Folder,
  type HttpRequest,
} from '@reqvyn/core';
import { ReqvynError, canonicalJson, isReqvynError, slugify, stableStringify } from '@reqvyn/shared';
import { sha256Hex } from '@reqvyn/shared/node';
import { zipSync } from 'fflate';
import { environmentTemplate, sanitizeCollection, type SensitiveFinding } from './secrets.js';
import type { ImportWarning } from './types.js';
import { safeUnzip, type ZipLimits } from './zip.js';

/**
 * REQVYN package format (`.reqvyn`): a ZIP archive
 *
 *   manifest.json                     – format, versions, file list with sha256, integrity hash
 *   collection/collection.json        – collection info (no folders/requests)
 *   collection/folders/<id>.json      – one file per folder
 *   collection/requests/<id>.json     – one file per request
 *   environments/<id>.json            – optional environment templates
 *
 * `integrity` = sha256(canonicalJson(files sorted by path)). It detects corruption and tampering
 * of individual files; it is NOT a signature (anyone can recompute it).
 */

export const PACKAGE_FORMAT = 'reqvyn-package';
export const PACKAGE_FORMAT_VERSION = 1;
export const PACKAGE_EXTENSION = '.reqvyn';

export interface PackageFileEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface PackageManifest {
  format: typeof PACKAGE_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  createdAt: string;
  generator: string;
  collection: { id: string; name: string };
  environments: Array<{ id: string; name: string }>;
  /** Export options that shaped this package (informational). */
  options: { includeEnvironmentValues: boolean; includeSecrets: boolean };
  files: PackageFileEntry[];
  integrity: string;
}

export interface CreatePackageOptions {
  environments?: Environment[];
  /** Keep non-secret environment values that look sensitive (default false: blanked). */
  includeEnvironmentValues?: boolean;
  /** Keep literal auth secrets and `secret: true` variable values. Default false — never enable silently. */
  includeSecrets?: boolean;
  /** Blank literal Authorization/Cookie/API-key header values (default true). */
  redactSensitiveHeaders?: boolean;
  /** Only include these request ids (folders on their path are kept). */
  requestIds?: string[];
  generator?: string;
  /** Fixed timestamp for reproducible packages. */
  createdAt?: string;
}

export interface BuiltPackage {
  bytes: Uint8Array;
  manifest: PackageManifest;
  /** Values that were blanked while building the package (for the export review). */
  removed: SensitiveFinding[];
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

/** File-name-safe representation of an id (ids are UUIDs, but imported ids may be arbitrary). */
function fileId(id: string, used: Set<string>): string {
  let base = /^[A-Za-z0-9._-]{1,100}$/.test(id) && !/^\.+$/.test(id) ? id : `${slugify(id, 'item')}-${sha256Hex(id).slice(0, 8)}`;
  while (used.has(base.toLowerCase())) base = `${base}-${sha256Hex(base).slice(0, 4)}`;
  used.add(base.toLowerCase());
  return base;
}

export function computeIntegrity(files: PackageFileEntry[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256Hex(canonicalJson(sorted.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size }))));
}

function subsetCollection(c: Collection, requestIds: string[]): Collection {
  const ids = new Set(requestIds);
  const requests = c.requests.filter((r) => ids.has(r.id));
  const keepFolders = new Set<string>();
  for (const r of requests) {
    let pid = r.parentId;
    while (pid && !keepFolders.has(pid)) {
      keepFolders.add(pid);
      pid = c.folders.find((f) => f.id === pid)?.parentId ?? null;
    }
  }
  return { ...c, requests, folders: c.folders.filter((f) => keepFolders.has(f.id)) };
}

export function buildPackage(collectionIn: Collection, opts: CreatePackageOptions = {}): BuiltPackage {
  const validated = parseCollection(collectionIn);
  const source = opts.requestIds ? subsetCollection(validated, opts.requestIds) : validated;
  const { collection, removed } = sanitizeCollection(source, {
    includeSecrets: opts.includeSecrets === true,
    redactSensitiveHeaders: opts.redactSensitiveHeaders,
  });
  const files: Record<string, Uint8Array> = {};
  const entries: PackageFileEntry[] = [];
  const add = (path: string, value: unknown) => {
    const data = enc.encode(stableStringify(value));
    files[path] = data;
    entries.push({ path, sha256: sha256Hex(data), size: data.length });
  };
  const { folders, requests, ...info } = collection;
  add('collection/collection.json', info);
  const used = new Set<string>();
  for (const f of folders) add(`collection/folders/${fileId(f.id, used)}.json`, f);
  for (const r of requests) add(`collection/requests/${fileId(r.id, used)}.json`, r);
  const envMeta: Array<{ id: string; name: string }> = [];
  const envUsed = new Set<string>();
  for (const e of opts.environments ?? []) {
    const env = parseEnvironment(e);
    const t = environmentTemplate(env, { includeEnvironmentValues: opts.includeEnvironmentValues === true, includeSecrets: opts.includeSecrets === true });
    removed.push(...t.removed);
    add(`environments/${fileId(env.id, envUsed)}.json`, t.environment);
    envMeta.push({ id: env.id, name: env.name });
  }
  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    generator: opts.generator ?? 'REQVYN',
    collection: { id: collection.id, name: collection.name },
    environments: envMeta,
    options: { includeEnvironmentValues: opts.includeEnvironmentValues === true, includeSecrets: opts.includeSecrets === true },
    files: entries,
    integrity: computeIntegrity(entries),
  };
  const zipInput: Record<string, [Uint8Array, { level: 6 | 0; mtime: Date }]> = {};
  const mtime = new Date(manifest.createdAt);
  const safeMtime = Number.isNaN(mtime.getTime()) || mtime.getFullYear() < 1980 ? new Date('1980-01-01T00:00:00Z') : mtime;
  zipInput['manifest.json'] = [enc.encode(stableStringify(manifest)), { level: 6, mtime: safeMtime }];
  for (const [path, data] of Object.entries(files)) zipInput[path] = [data, { level: 6, mtime: safeMtime }];
  return { bytes: zipSync(zipInput), manifest, removed };
}

/** Create a `.reqvyn` package. Secrets are never included unless `includeSecrets` is set. */
export function createPackage(collection: Collection, opts: CreatePackageOptions = {}): Uint8Array {
  return buildPackage(collection, opts).bytes;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

export interface ReadPackageResult {
  manifest: PackageManifest;
  collection: Collection;
  environments: Environment[];
  warnings: ImportWarning[];
}

function fail(message: string, details?: Record<string, unknown>): ReqvynError {
  return new ReqvynError('VALIDATION', `Invalid REQVYN package: ${message}`, details ? { details } : {});
}

function parseJsonFile(path: string, data: Uint8Array): unknown {
  try {
    return JSON.parse(dec.decode(data));
  } catch (e) {
    throw fail(`"${path}" is not valid UTF-8 JSON.`, { path, cause: String(e) });
  }
}

function validateManifest(raw: unknown): PackageManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw fail('manifest.json is not an object.');
  const m = raw as Record<string, unknown>;
  if (m.format !== PACKAGE_FORMAT) throw fail(`unexpected format "${String(m.format)}".`);
  if (typeof m.formatVersion !== 'number' || !Number.isInteger(m.formatVersion)) throw fail('missing formatVersion.');
  if (m.formatVersion > PACKAGE_FORMAT_VERSION)
    throw new ReqvynError('VALIDATION', `Package format version ${m.formatVersion} is newer than supported (${PACKAGE_FORMAT_VERSION}).`, { hint: 'Update REQVYN to open this package.' });
  if (typeof m.schemaVersion !== 'number' || m.schemaVersion > SCHEMA_VERSION)
    throw new ReqvynError('VALIDATION', `Package schema version ${String(m.schemaVersion)} is not supported by this REQVYN version (${SCHEMA_VERSION}).`, { hint: 'Update REQVYN to open this package.' });
  if (!Array.isArray(m.files)) throw fail('manifest has no file list.');
  const files: PackageFileEntry[] = [];
  const seen = new Set<string>();
  for (const f of m.files) {
    if (typeof f !== 'object' || f === null) throw fail('invalid file entry in manifest.');
    const e = f as Record<string, unknown>;
    if (typeof e.path !== 'string' || typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256) || typeof e.size !== 'number')
      throw fail('invalid file entry in manifest.', { entry: e.path });
    if (seen.has(e.path)) throw fail(`duplicate manifest entry "${e.path}".`);
    seen.add(e.path);
    files.push({ path: e.path, sha256: e.sha256, size: e.size });
  }
  if (typeof m.integrity !== 'string') throw fail('manifest has no integrity hash.');
  const col = (m.collection ?? {}) as Record<string, unknown>;
  return {
    format: PACKAGE_FORMAT,
    formatVersion: m.formatVersion,
    schemaVersion: m.schemaVersion,
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : '',
    generator: typeof m.generator === 'string' ? m.generator.slice(0, 200) : '',
    collection: { id: String(col.id ?? ''), name: String(col.name ?? '') },
    environments: Array.isArray(m.environments)
      ? m.environments.filter((e): e is { id: string; name: string } => typeof e === 'object' && e !== null).map((e) => ({ id: String(e.id), name: String(e.name) }))
      : [],
    options: {
      includeEnvironmentValues: (m.options as Record<string, unknown> | undefined)?.includeEnvironmentValues === true,
      includeSecrets: (m.options as Record<string, unknown> | undefined)?.includeSecrets === true,
    },
    files,
    integrity: m.integrity,
  };
}

/**
 * Read and fully validate a `.reqvyn` package in memory: safe extraction (zip-slip, size, count and
 * zip-bomb checks), per-file sha256 + overall integrity verification, and schema validation of
 * every JSON document. Unknown files are reported as warnings and ignored.
 */
export function readPackage(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): ReadPackageResult {
  const files = safeUnzip(bytes, limits);
  const warnings: ImportWarning[] = [];
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw fail('manifest.json is missing.');
  const manifest = validateManifest(parseJsonFile('manifest.json', manifestBytes));

  if (computeIntegrity(manifest.files) !== manifest.integrity)
    throw new ReqvynError('UNTRUSTED', 'Package integrity check failed: the manifest file list was modified.', { hint: 'The package is corrupted or was tampered with.' });
  for (const f of manifest.files) {
    const data = files.get(f.path);
    if (!data) throw fail(`file "${f.path}" listed in the manifest is missing.`, { path: f.path });
    if (data.length !== f.size || sha256Hex(data) !== f.sha256)
      throw new ReqvynError('UNTRUSTED', `Package integrity check failed for "${f.path}".`, { details: { path: f.path }, hint: 'The package is corrupted or was tampered with.' });
  }
  const listed = new Set(manifest.files.map((f) => f.path));
  for (const path of files.keys()) {
    if (path !== 'manifest.json' && !listed.has(path))
      warnings.push({ format: 'reqvyn-package', code: 'unknown-file', message: `Unlisted file "${path}" in the package was ignored.`, location: path });
  }

  const wrap = <T>(path: string, fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (isReqvynError(e)) throw fail(`${path}: ${e.message}`, { path });
      throw e;
    }
  };
  const infoBytes = files.get('collection/collection.json');
  if (!infoBytes || !listed.has('collection/collection.json')) throw fail('collection/collection.json is missing.');
  const info = wrap('collection/collection.json', () => parseCollectionInfo(parseJsonFile('collection/collection.json', infoBytes)));
  const folders: Folder[] = [];
  const requests: HttpRequest[] = [];
  const environments: Environment[] = [];
  const ids = new Set<string>([info.id]);
  for (const f of manifest.files) {
    const data = files.get(f.path) as Uint8Array;
    if (f.path === 'collection/collection.json') continue;
    if (/^collection\/folders\/[^/]+\.json$/.test(f.path)) {
      const folder = wrap(f.path, () => parseFolder(parseJsonFile(f.path, data)));
      if (ids.has(folder.id)) throw fail(`duplicate id "${folder.id}" (${f.path}).`);
      ids.add(folder.id);
      folders.push(folder);
    } else if (/^collection\/requests\/[^/]+\.json$/.test(f.path)) {
      const request = wrap(f.path, () => parseRequest(parseJsonFile(f.path, data)));
      if (ids.has(request.id)) throw fail(`duplicate id "${request.id}" (${f.path}).`);
      ids.add(request.id);
      requests.push(request);
    } else if (/^environments\/[^/]+\.json$/.test(f.path)) {
      environments.push(wrap(f.path, () => parseEnvironment(parseJsonFile(f.path, data))));
    } else {
      warnings.push({ format: 'reqvyn-package', code: 'unknown-file', message: `Unknown file "${f.path}" was ignored.`, location: f.path });
    }
  }
  const folderIds = new Set(folders.map((f) => f.id));
  for (const item of [...folders, ...requests]) {
    if (item.parentId && !folderIds.has(item.parentId)) {
      warnings.push({ format: 'reqvyn-package', code: 'converted', message: `"${item.name}" referenced a missing folder and was moved to the root.`, location: item.name });
      item.parentId = null;
    }
  }
  const collection = parseCollection({ ...info, folders, requests });
  if (manifest.collection.id && manifest.collection.id !== collection.id)
    warnings.push({ format: 'reqvyn-package', code: 'info', message: 'Manifest collection id differs from the collection file; the collection file was used.' });
  if (manifest.options.includeSecrets)
    warnings.push({ format: 'reqvyn-package', code: 'secret', message: 'This package was exported WITH secrets. Review credentials before sharing it further.' });
  return { manifest, collection, environments, warnings };
}

/** Cheap check for the ZIP signature. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}
