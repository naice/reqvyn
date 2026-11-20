import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  SYNC_FORMAT_VERSION,
  SyncProviderError,
  computeSnapshotRevision,
  manifestFromSnapshot,
  stableStringify,
  validateSnapshot,
  type SyncEntity,
  type SyncManifest,
  type SyncSnapshot,
} from '@reqvyn/provider-sdk';
import { encodeFileName, renameWithRetry, writeFileAtomic, writeTempFile } from './atomic.js';

/**
 * On-disk layout of one collection (shared by the Local Folder and Git providers):
 *
 * ```text
 * <root>/<collectionId>/
 *   manifest.json        commit point: revision, updatedAt, entity id → {kind, hash}
 *   entities/<id>.json   { id, kind, hash, data }   (one file per collection-info/folder/request)
 *   tombstones.json      deletion markers
 *   .lock                writer lock (transient)
 *   .staging/            write journal (transient, see below)
 * ```
 *
 * Writes go through a journal: all changed files are staged and fsynced, then `plan.json` is
 * written atomically (the "ready" marker), then files are renamed into place with `manifest.json`
 * last. An interrupted write is recovered by the next writer/reader: a journal without plan is
 * discarded (old state intact), a journal with plan is rolled forward. Ids are encoded with
 * {@link encodeFileName}.
 */

export const MANIFEST_FILE = 'manifest.json';
export const TOMBSTONES_FILE = 'tombstones.json';
export const ENTITIES_DIR = 'entities';
export const STAGING_DIR = '.staging';
export const LOCK_FILE = '.lock';
const PLAN_FILE = 'plan.json';

interface WritePlan {
  revision: string;
  createdAt: string;
  /** Entity file names staged under `<staging>/entities`. */
  writes: string[];
  /** Entity file names to remove after the manifest is committed. */
  deletes: string[];
}

/** Hooks for fault-injection tests. Throwing from a hook simulates a crash at that point. */
export interface WriteHooks {
  afterStage?: () => void | Promise<void>;
  afterApplyFile?: (index: number) => void | Promise<void>;
}

export interface WriteCollectionOptions {
  /** Journal location (default `<dir>/.staging`). Must be on the same volume as `dir`. */
  stagingDir?: string;
  hooks?: WriteHooks;
  updatedAt?: string;
}

async function readJson(file: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new SyncProviderError('INVALID_DATA', `Corrupted sync file ${path.basename(file)}`, { cause: e, details: { file } });
  }
}

/** Read and validate `manifest.json` of a collection directory (`null` if absent). */
export async function readManifest(dir: string): Promise<SyncManifest | null> {
  const m = (await readJson(path.join(dir, MANIFEST_FILE))) as SyncManifest | undefined;
  if (m === undefined) return null;
  if (typeof m !== 'object' || m === null || typeof m.revision !== 'string' || typeof m.collectionId !== 'string' || typeof m.entities !== 'object') {
    throw new SyncProviderError('INVALID_DATA', 'Invalid manifest.json');
  }
  if (typeof m.formatVersion !== 'number' || m.formatVersion > SYNC_FORMAT_VERSION) {
    throw new SyncProviderError('INVALID_DATA', `Unsupported sync format version ${String(m.formatVersion)}`);
  }
  return m;
}

/** Read the full snapshot of a collection directory (`null` if it has no manifest). */
export async function readCollectionDir(dir: string, collectionId: string): Promise<SyncSnapshot | null> {
  const manifest = await readManifest(dir);
  if (!manifest) return null;
  if (manifest.collectionId !== collectionId) {
    throw new SyncProviderError('INVALID_DATA', `Folder contains collection ${manifest.collectionId}, expected ${collectionId}`);
  }
  const entities: Record<string, SyncEntity> = {};
  for (const [id, meta] of Object.entries(manifest.entities)) {
    const file = path.join(dir, ENTITIES_DIR, `${encodeFileName(id)}.json`);
    const e = (await readJson(file)) as (SyncEntity & { id: string }) | undefined;
    if (!e) throw new SyncProviderError('INVALID_DATA', `Missing entity file for ${id}`, { details: { id } });
    if (e.id !== id || e.hash !== meta.hash || e.kind !== meta.kind) {
      throw new SyncProviderError('INVALID_DATA', `Entity file for ${id} does not match the manifest`, { details: { id } });
    }
    entities[id] = { kind: e.kind, hash: e.hash, data: e.data };
  }
  const tombstones = ((await readJson(path.join(dir, TOMBSTONES_FILE))) as unknown[] | undefined) ?? [];
  // validateSnapshot re-verifies every entity hash against its data.
  return validateSnapshot(
    {
      formatVersion: manifest.formatVersion,
      collectionId,
      revision: manifest.revision,
      updatedAt: manifest.updatedAt,
      label: manifest.label,
      entities,
      tombstones,
    },
    { collectionId },
  );
}

/** Write `snapshot` into `dir` through the journal. Returns the committed manifest. */
export async function writeCollectionDir(dir: string, snapshot: SyncSnapshot, options: WriteCollectionOptions = {}): Promise<SyncManifest> {
  const staging = options.stagingDir ?? path.join(dir, STAGING_DIR);
  await recoverCollectionDir(dir, { stagingDir: staging });
  const normalized: SyncSnapshot = { ...snapshot, formatVersion: SYNC_FORMAT_VERSION, revision: null };
  const revision = computeSnapshotRevision(normalized);
  const manifest = manifestFromSnapshot(normalized, revision, options.updatedAt ?? new Date().toISOString());
  const previous = await readManifest(dir).catch(() => null);

  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(path.join(staging, ENTITIES_DIR), { recursive: true });
  await fs.mkdir(path.join(dir, ENTITIES_DIR), { recursive: true });

  const wanted = new Set<string>();
  const writes: string[] = [];
  for (const [id, e] of Object.entries(snapshot.entities)) {
    const name = `${encodeFileName(id)}.json`;
    wanted.add(name);
    const prev = previous?.entities[id];
    if (prev && prev.hash === e.hash && prev.kind === e.kind) {
      try {
        await fs.access(path.join(dir, ENTITIES_DIR, name));
        continue; // unchanged and present
      } catch {
        /* missing – rewrite */
      }
    }
    await writeFileAtomic(path.join(staging, ENTITIES_DIR, name), stableStringify({ id, kind: e.kind, hash: e.hash, data: e.data }));
    writes.push(name);
  }
  const existing = await fs.readdir(path.join(dir, ENTITIES_DIR)).catch(() => [] as string[]);
  const deletes = existing.filter((n) => n.endsWith('.json') && !wanted.has(n));
  await writeFileAtomic(path.join(staging, TOMBSTONES_FILE), stableStringify(snapshot.tombstones));
  await writeFileAtomic(path.join(staging, MANIFEST_FILE), stableStringify(manifest));
  const plan: WritePlan = { revision, createdAt: new Date().toISOString(), writes, deletes };
  await writeFileAtomic(path.join(staging, PLAN_FILE), stableStringify(plan));
  await options.hooks?.afterStage?.();
  await applyJournal(dir, staging, options.hooks);
  return manifest;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function applyJournal(dir: string, staging: string, hooks?: WriteHooks): Promise<void> {
  const plan = (await readJson(path.join(staging, PLAN_FILE))) as WritePlan;
  await fs.mkdir(path.join(dir, ENTITIES_DIR), { recursive: true });
  let i = 0;
  for (const name of plan.writes) {
    const src = path.join(staging, ENTITIES_DIR, name);
    if (await exists(src)) await renameWithRetry(src, path.join(dir, ENTITIES_DIR, name));
    await hooks?.afterApplyFile?.(i++);
  }
  const tomb = path.join(staging, TOMBSTONES_FILE);
  if (await exists(tomb)) await renameWithRetry(tomb, path.join(dir, TOMBSTONES_FILE));
  const man = path.join(staging, MANIFEST_FILE);
  if (await exists(man)) await renameWithRetry(man, path.join(dir, MANIFEST_FILE)); // commit point
  for (const name of plan.deletes) await fs.rm(path.join(dir, ENTITIES_DIR, name), { force: true });
  await fs.rm(staging, { recursive: true, force: true });
}

/**
 * Complete or discard an interrupted write. Must be called while holding the collection lock.
 * Returns what was done.
 */
export async function recoverCollectionDir(dir: string, options: { stagingDir?: string } = {}): Promise<'none' | 'rolled-forward' | 'discarded'> {
  const staging = options.stagingDir ?? path.join(dir, STAGING_DIR);
  if (!(await exists(staging))) return 'none';
  let plan: unknown;
  try {
    plan = await readJson(path.join(staging, PLAN_FILE));
  } catch {
    plan = undefined;
  }
  if (plan && typeof plan === 'object' && Array.isArray((plan as WritePlan).writes)) {
    await applyJournal(dir, staging);
    return 'rolled-forward';
  }
  await fs.rm(staging, { recursive: true, force: true });
  return 'discarded';
}

/** Remove a collection directory's sync files (manifest first, so readers see "absent" atomically). */
export async function removeCollectionFiles(dir: string, options: { stagingDir?: string } = {}): Promise<void> {
  await fs.rm(path.join(dir, MANIFEST_FILE), { force: true });
  await fs.rm(path.join(dir, ENTITIES_DIR), { recursive: true, force: true });
  await fs.rm(path.join(dir, TOMBSTONES_FILE), { force: true });
  await fs.rm(options.stagingDir ?? path.join(dir, STAGING_DIR), { recursive: true, force: true });
}

/** Remove stray temp files left behind by crashed atomic writes (best effort). */
export async function cleanTempFiles(dir: string): Promise<number> {
  let removed = 0;
  for (const sub of [dir, path.join(dir, ENTITIES_DIR)]) {
    const names = await fs.readdir(sub).catch(() => [] as string[]);
    for (const n of names) {
      if (n.startsWith('.') && n.endsWith('.tmp')) {
        await fs.rm(path.join(sub, n), { force: true }).catch(() => undefined);
        removed++;
      }
    }
  }
  return removed;
}

export { writeTempFile };
