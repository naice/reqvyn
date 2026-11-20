import { parseCollection, type Collection } from '@reqvyn/core';
import { ReqvynError, deepClone } from '@reqvyn/shared';
import { contentHash } from '@reqvyn/shared/node';
import {
  SYNC_FORMAT_VERSION,
  type JsonValue,
  type SyncEntity,
  type SyncEntityKind,
  type SyncSnapshot,
  type SyncTombstone,
} from '@reqvyn/provider-sdk';

/** Build an entity with a canonical content hash. `data` is deep-copied into plain JSON. */
export function toEntity(kind: SyncEntityKind, data: unknown): SyncEntity {
  const clean = (deepClone(data) ?? null) as JsonValue;
  return { kind, hash: contentHash(clean), data: clean };
}

export interface CollectionToSnapshotOptions {
  revision?: string | null;
  tombstones?: SyncTombstone[];
  updatedAt?: string;
}

/**
 * Decompose a collection into one entity per collection-info / folder / request. The collection
 * info entity is keyed by the collection id; folders and requests by their own stable ids.
 */
export function collectionToSnapshot(collection: Collection, options: CollectionToSnapshotOptions = {}): SyncSnapshot {
  const { folders, requests, ...info } = collection;
  const entities: Record<string, SyncEntity> = {};
  const add = (id: string, kind: SyncEntityKind, data: unknown) => {
    if (!id) throw new ReqvynError('VALIDATION', `A ${kind} without id cannot be synchronized`);
    if (entities[id]) throw new ReqvynError('VALIDATION', `Duplicate id ${id} in collection ${collection.id}`);
    entities[id] = toEntity(kind, data);
  };
  add(collection.id, 'collection', info);
  for (const f of folders) add(f.id, 'folder', f);
  for (const r of requests) add(r.id, 'request', r);
  return {
    formatVersion: SYNC_FORMAT_VERSION,
    collectionId: collection.id,
    revision: options.revision ?? null,
    ...(options.updatedAt ? { updatedAt: options.updatedAt } : {}),
    label: collection.name,
    entities,
    tombstones: (options.tombstones ?? []).filter((t) => !entities[t.id]),
  };
}

function parentOf(data: JsonValue): string | null {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const p = (data as Record<string, JsonValue>).parentId;
    return typeof p === 'string' && p ? p : null;
  }
  return null;
}

function bySortKey(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const sa = typeof a.sortKey === 'number' ? a.sortKey : 0;
  const sb = typeof b.sortKey === 'number' ? b.sortKey : 0;
  if (sa !== sb) return sa - sb;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

/**
 * Reassemble a collection from a snapshot and validate it with the domain schema. Items whose
 * parent folder is missing, or that form a parent cycle, are moved to the collection root so no
 * item ever becomes invisible.
 */
export function snapshotToCollection(snapshot: SyncSnapshot): Collection {
  const infoEntity = snapshot.entities[snapshot.collectionId];
  if (!infoEntity || infoEntity.kind !== 'collection') {
    throw new ReqvynError('SYNC', `Snapshot of ${snapshot.collectionId} has no collection entity`);
  }
  const folders: Array<Record<string, unknown>> = [];
  const requests: Array<Record<string, unknown>> = [];
  for (const [id, e] of Object.entries(snapshot.entities)) {
    if (id === snapshot.collectionId) continue;
    if (e.kind === 'collection') throw new ReqvynError('SYNC', `Snapshot contains a second collection entity ${id}`);
    const data = deepClone(e.data) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new ReqvynError('SYNC', `Entity ${id} is not an object`);
    data.id = id;
    (e.kind === 'folder' ? folders : requests).push(data);
  }
  folders.sort(bySortKey);
  requests.sort(bySortKey);

  const folderParents = new Map<string, string | null>(folders.map((f) => [f.id as string, parentOf(f as JsonValue)]));
  // Break parent cycles (possible after two installations move folders into each other).
  for (const f of folders) {
    const seen = new Set<string>([f.id as string]);
    let p = folderParents.get(f.id as string) ?? null;
    while (p && folderParents.has(p)) {
      if (seen.has(p)) {
        f.parentId = null;
        folderParents.set(f.id as string, null);
        break;
      }
      seen.add(p);
      p = folderParents.get(p) ?? null;
    }
  }
  for (const item of [...folders, ...requests]) {
    const p = parentOf(item as JsonValue);
    if (p && !folderParents.has(p)) item.parentId = null;
  }
  const info = deepClone(infoEntity.data) as Record<string, unknown>;
  return parseCollection({ ...info, id: snapshot.collectionId, folders, requests });
}
