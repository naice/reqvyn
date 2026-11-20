import { newId, ReqvynError, uniqueName, deepClone } from '@reqvyn/shared';
import { createFolder, createRequest, descendantIds, nowIso, type Collection, type Folder, type HttpRequest } from '@reqvyn/core';

/**
 * Pure, immutable tree mutations on a flat collection. Each returns a new collection plus the ids
 * of entities that changed/were removed, so stores can persist only what is necessary.
 */
export interface MutationResult {
  collection: Collection;
  changedFolders: string[];
  changedRequests: string[];
  removedFolders: string[];
  removedRequests: string[];
}

const result = (collection: Collection, p: Partial<Omit<MutationResult, 'collection'>> = {}): MutationResult => ({
  collection,
  changedFolders: p.changedFolders ?? [],
  changedRequests: p.changedRequests ?? [],
  removedFolders: p.removedFolders ?? [],
  removedRequests: p.removedRequests ?? [],
});

function siblings(c: Collection, parentId: string | null): Array<Folder | HttpRequest> {
  return [...c.folders.filter((f) => f.parentId === parentId), ...c.requests.filter((r) => r.parentId === parentId)];
}

function nextSortKey(c: Collection, parentId: string | null): number {
  const keys = siblings(c, parentId).map((s) => s.sortKey);
  return keys.length ? Math.max(...keys) + 1 : 0;
}

function assertFolder(c: Collection, id: string | null): void {
  if (id !== null && !c.folders.some((f) => f.id === id)) throw new ReqvynError('NOT_FOUND', `Folder ${id} not found.`);
}

export function addRequest(c: Collection, partial: Partial<HttpRequest> = {}, parentId: string | null = null): MutationResult & { request: HttpRequest } {
  assertFolder(c, parentId);
  const names = c.requests.filter((r) => r.parentId === parentId).map((r) => r.name);
  const request = createRequest({ ...partial, parentId, sortKey: nextSortKey(c, parentId), name: uniqueName(partial.name ?? 'New Request', names) });
  return { ...result({ ...c, requests: [...c.requests, request] }, { changedRequests: [request.id] }), request };
}

export function addFolder(c: Collection, name = 'New Folder', parentId: string | null = null): MutationResult & { folder: Folder } {
  assertFolder(c, parentId);
  const names = c.folders.filter((f) => f.parentId === parentId).map((f) => f.name);
  const folder = createFolder({ name: uniqueName(name, names), parentId, sortKey: nextSortKey(c, parentId) });
  return { ...result({ ...c, folders: [...c.folders, folder] }, { changedFolders: [folder.id] }), folder };
}

export function renameNode(c: Collection, id: string, name: string): MutationResult {
  const trimmed = name.trim();
  if (!trimmed) throw new ReqvynError('VALIDATION', 'Name must not be empty.');
  const now = nowIso();
  if (c.folders.some((f) => f.id === id)) {
    return result({ ...c, folders: c.folders.map((f) => (f.id === id ? { ...f, name: trimmed } : f)) }, { changedFolders: [id] });
  }
  if (c.requests.some((r) => r.id === id)) {
    return result({ ...c, requests: c.requests.map((r) => (r.id === id ? { ...r, name: trimmed, meta: { ...r.meta, updatedAt: now } } : r)) }, { changedRequests: [id] });
  }
  throw new ReqvynError('NOT_FOUND', `Item ${id} not found.`);
}

export function deleteNode(c: Collection, id: string): MutationResult {
  if (c.requests.some((r) => r.id === id)) {
    return result({ ...c, requests: c.requests.filter((r) => r.id !== id) }, { removedRequests: [id] });
  }
  if (!c.folders.some((f) => f.id === id)) throw new ReqvynError('NOT_FOUND', `Item ${id} not found.`);
  const d = descendantIds(c, id);
  const folders = new Set([id, ...d.folders]);
  const requests = new Set(d.requests);
  return result(
    { ...c, folders: c.folders.filter((f) => !folders.has(f.id)), requests: c.requests.filter((r) => !requests.has(r.id)) },
    { removedFolders: [...folders], removedRequests: [...requests] },
  );
}

export function duplicateRequest(c: Collection, id: string): MutationResult & { request: HttpRequest } {
  const src = c.requests.find((r) => r.id === id);
  if (!src) throw new ReqvynError('NOT_FOUND', `Request ${id} not found.`);
  const names = c.requests.filter((r) => r.parentId === src.parentId).map((r) => r.name);
  const now = nowIso();
  const copy: HttpRequest = { ...deepClone(src), id: newId(), name: uniqueName(`${src.name} Copy`, names), sortKey: src.sortKey + 0.5, meta: { ...src.meta, createdAt: now, updatedAt: now } };
  const next = normalizeSortKeys({ ...c, requests: [...c.requests, copy] }, src.parentId);
  return { ...result(next.collection, { changedRequests: [...new Set([copy.id, ...next.changed.requests])], changedFolders: next.changed.folders }), request: copy };
}

export function duplicateFolder(c: Collection, id: string): MutationResult & { folder: Folder } {
  const src = c.folders.find((f) => f.id === id);
  if (!src) throw new ReqvynError('NOT_FOUND', `Folder ${id} not found.`);
  const idMap = new Map<string, string>();
  const d = descendantIds(c, id);
  for (const fid of [id, ...d.folders]) idMap.set(fid, newId());
  const names = c.folders.filter((f) => f.parentId === src.parentId).map((f) => f.name);
  const newFolders = c.folders
    .filter((f) => idMap.has(f.id))
    .map((f) => ({
      ...deepClone(f),
      id: idMap.get(f.id)!,
      parentId: f.id === id ? f.parentId : idMap.get(f.parentId!)!,
      name: f.id === id ? uniqueName(`${f.name} Copy`, names) : f.name,
      sortKey: f.id === id ? f.sortKey + 0.5 : f.sortKey,
    }));
  const now = nowIso();
  const newRequests = c.requests
    .filter((r) => d.requests.includes(r.id))
    .map((r) => ({ ...deepClone(r), id: newId(), parentId: idMap.get(r.parentId!)!, meta: { ...r.meta, createdAt: now, updatedAt: now } }));
  const next = normalizeSortKeys({ ...c, folders: [...c.folders, ...newFolders], requests: [...c.requests, ...newRequests] }, src.parentId);
  return {
    ...result(next.collection, {
      changedFolders: [...new Set([...newFolders.map((f) => f.id), ...next.changed.folders])],
      changedRequests: [...new Set([...newRequests.map((r) => r.id), ...next.changed.requests])],
    }),
    folder: newFolders.find((f) => f.parentId === src.parentId && idMap.get(id) === f.id)!,
  };
}

/**
 * Move an item to `newParentId`, placing it before `beforeId` (or at the end).
 * Prevents moving a folder into itself or one of its descendants.
 */
export function moveNode(c: Collection, id: string, newParentId: string | null, beforeId?: string | null): MutationResult {
  assertFolder(c, newParentId);
  const isFolder = c.folders.some((f) => f.id === id);
  if (!isFolder && !c.requests.some((r) => r.id === id)) throw new ReqvynError('NOT_FOUND', `Item ${id} not found.`);
  if (isFolder && newParentId !== null) {
    if (newParentId === id || descendantIds(c, id).folders.includes(newParentId)) {
      throw new ReqvynError('VALIDATION', 'A folder cannot be moved into itself or one of its subfolders.');
    }
  }
  const ordered = siblings(c, newParentId)
    .filter((s) => s.id !== id)
    .sort((a, b) => a.sortKey - b.sortKey);
  const pos = beforeId ? ordered.findIndex((s) => s.id === beforeId) : -1;
  const moving = isFolder ? c.folders.find((f) => f.id === id)! : c.requests.find((r) => r.id === id)!;
  ordered.splice(pos === -1 ? ordered.length : pos, 0, moving);
  const keys = new Map(ordered.map((s, i) => [s.id, i]));
  const changedFolders: string[] = [];
  const changedRequests: string[] = [];
  const folders = c.folders.map((f) => {
    const k = keys.get(f.id);
    if (k === undefined) return f;
    const parentId = f.id === id ? newParentId : f.parentId;
    if (k === f.sortKey && parentId === f.parentId) return f;
    changedFolders.push(f.id);
    return { ...f, sortKey: k, parentId };
  });
  const requests = c.requests.map((r) => {
    const k = keys.get(r.id);
    if (k === undefined) return r;
    const parentId = r.id === id ? newParentId : r.parentId;
    if (k === r.sortKey && parentId === r.parentId) return r;
    changedRequests.push(r.id);
    return { ...r, sortKey: k, parentId };
  });
  return result({ ...c, folders, requests }, { changedFolders, changedRequests });
}

/** Renumber sort keys of a sibling group to 0..n-1 (keeps files stable when unchanged). */
export function normalizeSortKeys(c: Collection, parentId: string | null): { collection: Collection; changed: { folders: string[]; requests: string[] } } {
  const ordered = siblings(c, parentId).sort((a, b) => a.sortKey - b.sortKey);
  const keys = new Map(ordered.map((s, i) => [s.id, i]));
  const changed = { folders: [] as string[], requests: [] as string[] };
  const folders = c.folders.map((f) => {
    const k = keys.get(f.id);
    if (k === undefined || k === f.sortKey) return f;
    changed.folders.push(f.id);
    return { ...f, sortKey: k };
  });
  const requests = c.requests.map((r) => {
    const k = keys.get(r.id);
    if (k === undefined || k === r.sortKey) return r;
    changed.requests.push(r.id);
    return { ...r, sortKey: k };
  });
  return { collection: { ...c, folders, requests }, changed };
}

/** Move an item to another collection (new ids are not needed – ids are globally unique). */
export function moveToCollection(source: Collection, target: Collection, id: string, newParentId: string | null = null): { source: Collection; target: Collection } {
  assertFolder(target, newParentId);
  const isFolder = source.folders.some((f) => f.id === id);
  const d = isFolder ? descendantIds(source, id) : { folders: [], requests: [id] };
  const folderIds = new Set(isFolder ? [id, ...d.folders] : []);
  const requestIds = new Set(d.requests);
  const movedFolders = source.folders.filter((f) => folderIds.has(f.id)).map((f) => (f.id === id ? { ...f, parentId: newParentId, sortKey: nextSortKey(target, newParentId) } : f));
  const movedRequests = source.requests.filter((r) => requestIds.has(r.id)).map((r) => (r.id === id ? { ...r, parentId: newParentId, sortKey: nextSortKey(target, newParentId) } : r));
  return {
    source: { ...source, folders: source.folders.filter((f) => !folderIds.has(f.id)), requests: source.requests.filter((r) => !requestIds.has(r.id)) },
    target: { ...target, folders: [...target.folders, ...movedFolders], requests: [...target.requests, ...movedRequests] },
  };
}

/** Persist a mutation result through a store, writing only changed entities. */
export async function persistMutation(
  store: { saveRequest(cid: string, r: HttpRequest): Promise<void>; saveFolder(cid: string, f: Folder): Promise<void>; deleteRequest(cid: string, id: string): Promise<void>; deleteFolder(cid: string, id: string): Promise<void> },
  m: MutationResult,
): Promise<void> {
  const c = m.collection;
  for (const id of m.changedFolders) {
    const f = c.folders.find((x) => x.id === id);
    if (f) await store.saveFolder(c.id, f);
  }
  for (const id of m.changedRequests) {
    const r = c.requests.find((x) => x.id === id);
    if (r) await store.saveRequest(c.id, r);
  }
  for (const id of m.removedRequests) await store.deleteRequest(c.id, id);
  for (const id of m.removedFolders) await store.deleteFolder(c.id, id);
}
