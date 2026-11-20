import { ancestorFolders, parseCollection, type Collection, type Environment, type Folder, type HttpRequest } from '@reqvyn/core';
import { deepClone, newId, uniqueName } from '@reqvyn/shared';
import { scanForSecrets, type SensitiveFinding } from './secrets.js';
import type { ImportResult, ImportWarning } from './types.js';

/** Utilities to preview an import and merge imported data into existing collections. */

export interface RemapResult {
  collection: Collection;
  /** old id -> new id for the collection, folders and requests. */
  idMap: Map<string, string>;
}

/** Give the collection, its folders and requests fresh ids (parent links are rewritten). */
export function remapIds(c: Collection, opts: { keepCollectionId?: boolean } = {}): RemapResult {
  const copy = deepClone(c);
  const idMap = new Map<string, string>();
  const map = (id: string) => {
    let n = idMap.get(id);
    if (!n) {
      n = newId();
      idMap.set(id, n);
    }
    return n;
  };
  if (!opts.keepCollectionId) copy.id = map(c.id);
  for (const f of copy.folders) f.id = map(f.id);
  for (const r of copy.requests) r.id = map(r.id);
  for (const item of [...copy.folders, ...copy.requests]) if (item.parentId) item.parentId = idMap.get(item.parentId) ?? null;
  return { collection: copy, idMap };
}

export type ConflictKind = 'none' | 'same-id' | 'same-name';

export interface ImportPreview {
  collections: Array<{
    name: string;
    folders: number;
    requests: number;
    conflict: ConflictKind;
    existingId?: string;
    source?: string;
  }>;
  environments: Array<{ name: string; variables: number; conflict: ConflictKind; existingId?: string }>;
  warnings: ImportWarning[];
  /** Embedded credentials found in the imported data. */
  secrets: SensitiveFinding[];
  summary: string;
}

/** Summarize what an import would add and which items collide with existing ones. */
export function previewImport(result: ImportResult, existing: { collections?: Collection[]; environments?: Environment[] } = {}): ImportPreview {
  const cols = existing.collections ?? [];
  const envs = existing.environments ?? [];
  const conflictOf = <T extends { id: string; name: string }>(item: T, list: T[]): { conflict: ConflictKind; existingId?: string } => {
    const byId = list.find((x) => x.id === item.id);
    if (byId) return { conflict: 'same-id', existingId: byId.id };
    const byName = list.find((x) => x.name.toLowerCase() === item.name.toLowerCase());
    if (byName) return { conflict: 'same-name', existingId: byName.id };
    return { conflict: 'none' };
  };
  const preview: ImportPreview = {
    collections: result.collections.map((c) => ({
      name: c.name,
      folders: c.folders.length,
      requests: c.requests.length,
      ...conflictOf(c, cols),
      ...(c.meta.source?.type ? { source: c.meta.source.type } : {}),
    })),
    environments: result.environments.map((e) => ({ name: e.name, variables: e.variables.length, ...conflictOf(e, envs) })),
    warnings: result.warnings,
    secrets: scanForSecrets([...result.collections, ...result.environments]),
    summary: '',
  };
  const reqs = preview.collections.reduce((n, c) => n + c.requests, 0);
  const conflicts = [...preview.collections, ...preview.environments].filter((x) => x.conflict !== 'none').length;
  preview.summary = [
    `${preview.collections.length} collection(s) with ${reqs} request(s), ${preview.environments.length} environment(s)`,
    conflicts ? `${conflicts} conflict(s) with existing items` : '',
    result.warnings.length ? `${result.warnings.length} warning(s)` : '',
    preview.secrets.length ? `${preview.secrets.length} embedded credential(s)` : '',
  ]
    .filter(Boolean)
    .join('; ');
  return preview;
}

export type MergeStrategy =
  /** Add everything; colliding ids are remapped (default). */
  | 'keep-both'
  /** Replace target requests matched by id or by folder path + name + method. */
  | 'overwrite'
  /** Skip source requests that match an existing request. */
  | 'skip';

export interface MergeOptions {
  strategy?: MergeStrategy;
  /** Put the source content into this folder of the target (null/undefined: root). */
  intoFolderId?: string | null;
  /** Wrap the source content in a new folder named after the source collection. */
  wrapInFolder?: boolean;
}

export interface MergeResult {
  collection: Collection;
  added: { folders: number; requests: number };
  replaced: number;
  skipped: number;
}

function requestPath(c: Collection, r: HttpRequest): string {
  return [...ancestorFolders(c, r.parentId).map((f) => f.name), r.name, r.method.toUpperCase()].join('\u0000').toLowerCase();
}

function folderPathKey(c: Collection, f: Folder): string {
  return [...ancestorFolders(c, f.parentId).map((x) => x.name), f.name].join('\u0000').toLowerCase();
}

/** Merge `source` (e.g. an imported collection) into `target`. Returns a new collection. */
export function mergeCollections(targetIn: Collection, sourceIn: Collection, opts: MergeOptions = {}): MergeResult {
  const strategy = opts.strategy ?? 'keep-both';
  const target = deepClone(targetIn);
  const source = deepClone(sourceIn);
  const result: MergeResult = { collection: target, added: { folders: 0, requests: 0 }, replaced: 0, skipped: 0 };
  let rootParent: string | null = opts.intoFolderId ?? null;
  if (rootParent && !target.folders.some((f) => f.id === rootParent)) rootParent = null;
  const nextSort = (parentId: string | null) => {
    const keys = [...target.folders, ...target.requests].filter((x) => x.parentId === parentId).map((x) => x.sortKey);
    return keys.length ? Math.max(...keys) + 1 : 0;
  };
  if (opts.wrapInFolder) {
    const names = target.folders.filter((f) => f.parentId === rootParent).map((f) => f.name);
    const wrapper = parseCollection({
      ...target,
      folders: [{ id: newId(), name: uniqueName(source.name, names), parentId: rootParent, sortKey: nextSort(rootParent), description: source.description, variables: source.variables, headers: source.headers, auth: source.auth.type === 'none' ? { type: 'inherit' } : source.auth, scripts: source.scripts, tests: source.tests, settings: source.settings }],
      requests: [],
    }).folders[0] as Folder;
    target.folders.push(wrapper);
    result.added.folders++;
    rootParent = wrapper.id;
  }

  // Match folders by path so that "overwrite"/"skip" can merge into existing folders.
  const targetFolderByPath = new Map(target.folders.map((f) => [folderPathKey(target, f), f]));
  const usedIds = new Set([target.id, ...target.folders.map((f) => f.id), ...target.requests.map((r) => r.id)]);
  const folderMap = new Map<string, string>();
  const ordered: Folder[] = [];
  const pending = [...source.folders];
  const placed = new Set<string>();
  // Parents before children (guards against cycles).
  for (let guard = 0; pending.length && guard < source.folders.length + 1; guard++) {
    for (let i = 0; i < pending.length; i++) {
      const f = pending[i] as Folder;
      if (!f.parentId || placed.has(f.parentId) || !source.folders.some((x) => x.id === f.parentId)) {
        ordered.push(f);
        placed.add(f.id);
        pending.splice(i--, 1);
      }
    }
  }
  ordered.push(...pending);
  for (const f of ordered) {
    const parentId = f.parentId && folderMap.has(f.parentId) ? (folderMap.get(f.parentId) as string) : rootParent;
    if (strategy !== 'keep-both' && !opts.wrapInFolder) {
      const key = [...(parentId ? ancestorFolders(target, parentId).map((x) => x.name) : []), f.name].join('\u0000').toLowerCase();
      const existing = targetFolderByPath.get(key);
      if (existing) {
        folderMap.set(f.id, existing.id);
        continue;
      }
    }
    const id = usedIds.has(f.id) ? newId() : f.id;
    usedIds.add(id);
    folderMap.set(f.id, id);
    const folder: Folder = { ...f, id, parentId, sortKey: nextSort(parentId) };
    target.folders.push(folder);
    targetFolderByPath.set(folderPathKey(target, folder), folder);
    result.added.folders++;
  }
  const targetByPath = new Map(target.requests.map((r) => [requestPath(target, r), r]));
  for (const r of source.requests) {
    const parentId = r.parentId && folderMap.has(r.parentId) ? (folderMap.get(r.parentId) as string) : rootParent;
    const placedReq: HttpRequest = { ...r, parentId };
    const match = strategy === 'keep-both' ? undefined : target.requests.find((x) => x.id === r.id) ?? targetByPath.get(requestPath(target, placedReq));
    if (match && strategy === 'skip') {
      result.skipped++;
      continue;
    }
    if (match && strategy === 'overwrite') {
      const idx = target.requests.indexOf(match);
      target.requests[idx] = { ...placedReq, id: match.id, parentId: match.parentId, sortKey: match.sortKey };
      result.replaced++;
      continue;
    }
    const id = usedIds.has(r.id) ? newId() : r.id;
    usedIds.add(id);
    target.requests.push({ ...placedReq, id, sortKey: nextSort(parentId) });
    result.added.requests++;
  }
  // Collection variables from the source that the target lacks.
  const varNames = new Set(target.variables.map((v) => v.key));
  for (const v of source.variables) if (!varNames.has(v.key)) target.variables.push({ ...v, id: newId() });
  result.collection = parseCollection(target);
  return result;
}
