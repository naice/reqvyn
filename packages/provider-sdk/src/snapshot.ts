import { SyncProviderError } from './errors.js';
import { hashJson } from './hash.js';
import { isJsonObject, type JsonValue } from './json.js';
import {
  SYNC_FORMAT_VERSION,
  type SyncEntity,
  type SyncEntityKind,
  type SyncManifest,
  type SyncSnapshot,
  type SyncTombstone,
} from './types.js';

const KINDS: readonly SyncEntityKind[] = ['collection', 'folder', 'request'];

/** Content hash of an entity payload (SHA-256 of canonical JSON). */
export function hashEntityData(data: JsonValue): string {
  return hashJson(data);
}

/** Build an entity with a correctly computed hash. */
export function createEntity(kind: SyncEntityKind, data: JsonValue): SyncEntity {
  return { kind, hash: hashEntityData(data), data };
}

/** An empty snapshot for `collectionId`. */
export function emptySnapshot(collectionId: string): SyncSnapshot {
  return { formatVersion: SYNC_FORMAT_VERSION, collectionId, revision: null, entities: {}, tombstones: [] };
}

function sortedTombstones(tombstones: readonly SyncTombstone[]): SyncTombstone[] {
  return [...tombstones].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Deterministic content revision of a snapshot: SHA-256 over collection id, entity ids/kinds/
 * hashes and tombstones. Independent of `revision`, `updatedAt` and key order. File-based
 * providers use it as their revision.
 */
export function computeSnapshotRevision(snapshot: SyncSnapshot): string {
  const entities: Record<string, string> = {};
  for (const id of Object.keys(snapshot.entities).sort()) {
    const e = snapshot.entities[id]!;
    entities[id] = `${e.kind}:${e.hash}`;
  }
  return hashJson({
    formatVersion: snapshot.formatVersion,
    collectionId: snapshot.collectionId,
    entities,
    tombstones: sortedTombstones(snapshot.tombstones).map((t) => [t.id, t.kind, t.deletedAt]),
  });
}

/** Derive a manifest (entity hashes only) from a snapshot. */
export function manifestFromSnapshot(snapshot: SyncSnapshot, revision?: string, updatedAt?: string): SyncManifest {
  const entities: SyncManifest['entities'] = {};
  for (const id of Object.keys(snapshot.entities).sort()) {
    const e = snapshot.entities[id]!;
    entities[id] = { kind: e.kind, hash: e.hash };
  }
  return {
    formatVersion: snapshot.formatVersion,
    collectionId: snapshot.collectionId,
    revision: revision ?? snapshot.revision ?? computeSnapshotRevision(snapshot),
    updatedAt: updatedAt ?? snapshot.updatedAt ?? new Date().toISOString(),
    label: snapshot.label,
    entities,
    tombstoneCount: snapshot.tombstones.length,
  };
}

function invalid(message: string, details?: Record<string, unknown>): SyncProviderError {
  return new SyncProviderError('INVALID_DATA', message, { details });
}

export interface ValidateSnapshotOptions {
  /** Recompute and verify every entity hash (default `true`). */
  verifyHashes?: boolean;
  /** Expected collection id. */
  collectionId?: string;
  /** Maximum number of entities accepted (default 1,000,000). */
  maxEntities?: number;
}

/**
 * Structurally validate an untrusted snapshot (e.g. parsed from a remote file or HTTP body).
 * Returns a normalized snapshot or throws a `SyncProviderError` with code `INVALID_DATA`.
 */
export function validateSnapshot(value: unknown, options: ValidateSnapshotOptions = {}): SyncSnapshot {
  if (!isJsonObject(value)) throw invalid('Snapshot must be a JSON object');
  const v = value as Record<string, unknown>;
  const formatVersion = v.formatVersion;
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw invalid('Snapshot has no valid formatVersion');
  }
  if (formatVersion > SYNC_FORMAT_VERSION) {
    throw invalid(`Snapshot format ${formatVersion} is newer than supported version ${SYNC_FORMAT_VERSION}`);
  }
  if (typeof v.collectionId !== 'string' || !v.collectionId) throw invalid('Snapshot has no collectionId');
  if (options.collectionId !== undefined && v.collectionId !== options.collectionId) {
    throw invalid(`Snapshot belongs to collection ${v.collectionId}, expected ${options.collectionId}`);
  }
  if (v.revision !== null && v.revision !== undefined && typeof v.revision !== 'string') throw invalid('Invalid revision');
  if (!isJsonObject(v.entities)) throw invalid('Snapshot entities must be an object');
  const ids = Object.keys(v.entities);
  if (ids.length > (options.maxEntities ?? 1_000_000)) throw invalid('Snapshot has too many entities');
  const entities: Record<string, SyncEntity> = {};
  const verify = options.verifyHashes ?? true;
  for (const id of ids) {
    if (!id) throw invalid('Entity with empty id');
    const e = (v.entities as Record<string, unknown>)[id];
    if (!isJsonObject(e)) throw invalid(`Entity ${id} must be an object`);
    const kind = e.kind as SyncEntityKind;
    if (!KINDS.includes(kind)) throw invalid(`Entity ${id} has invalid kind`);
    if (typeof e.hash !== 'string' || !e.hash) throw invalid(`Entity ${id} has no hash`);
    if (!('data' in e)) throw invalid(`Entity ${id} has no data`);
    const data = e.data as JsonValue;
    if (verify && hashEntityData(data) !== e.hash) throw invalid(`Entity ${id} failed integrity check (hash mismatch)`, { id });
    entities[id] = { kind, hash: e.hash, data };
  }
  const rawTombs = v.tombstones ?? [];
  if (!Array.isArray(rawTombs)) throw invalid('Snapshot tombstones must be an array');
  const tombstones: SyncTombstone[] = [];
  for (const t of rawTombs) {
    if (!isJsonObject(t) || typeof t.id !== 'string' || !KINDS.includes(t.kind as SyncEntityKind) || typeof t.deletedAt !== 'string') {
      throw invalid('Invalid tombstone');
    }
    tombstones.push({
      id: t.id,
      kind: t.kind as SyncEntityKind,
      deletedAt: t.deletedAt,
      revisionAt: typeof t.revisionAt === 'string' ? t.revisionAt : null,
      ...(typeof t.lastHash === 'string' ? { lastHash: t.lastHash } : {}),
    });
  }
  return {
    formatVersion,
    collectionId: v.collectionId,
    revision: typeof v.revision === 'string' ? v.revision : null,
    ...(typeof v.updatedAt === 'string' ? { updatedAt: v.updatedAt } : {}),
    ...(typeof v.label === 'string' ? { label: v.label } : {}),
    entities,
    tombstones,
  };
}
