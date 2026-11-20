import type {
  AssertionGroup,
  Auth,
  Collection,
  Folder,
  HttpRequest,
  KeyValue,
  RequestSettings,
  Scripts,
} from './models.js';

export interface TreeNode {
  kind: 'folder' | 'request';
  id: string;
  name: string;
  parentId: string | null;
  sortKey: number;
  method?: string;
  children: TreeNode[];
}

function bySortKey<T extends { sortKey: number; name: string }>(a: T, b: T): number {
  return a.sortKey - b.sortKey || a.name.localeCompare(b.name);
}

export function childFolders(c: Collection, parentId: string | null): Folder[] {
  return c.folders.filter((f) => f.parentId === parentId).sort(bySortKey);
}

export function childRequests(c: Collection, parentId: string | null): HttpRequest[] {
  return c.requests.filter((r) => r.parentId === parentId).sort(bySortKey);
}

/** Build a sorted tree. Orphans (parent missing) are attached to the root so no data is ever hidden. */
export function buildTree(c: Collection): TreeNode[] {
  const folderIds = new Set(c.folders.map((f) => f.id));
  const norm = (p: string | null) => (p && folderIds.has(p) ? p : null);
  const build = (parentId: string | null, seen: Set<string>): TreeNode[] => {
    const folders = c.folders
      .filter((f) => norm(f.parentId) === parentId && !seen.has(f.id))
      .sort(bySortKey)
      .map((f): TreeNode => {
        const nextSeen = new Set(seen).add(f.id);
        return { kind: 'folder', id: f.id, name: f.name, parentId, sortKey: f.sortKey, children: build(f.id, nextSeen) };
      });
    const requests = c.requests
      .filter((r) => norm(r.parentId) === parentId)
      .sort(bySortKey)
      .map((r): TreeNode => ({ kind: 'request', id: r.id, name: r.name, parentId, sortKey: r.sortKey, method: r.method, children: [] }));
    return [...folders, ...requests];
  };
  return build(null, new Set());
}

/** Folder chain from the root down to (and excluding) the item. */
export function ancestorFolders(c: Collection, parentId: string | null): Folder[] {
  const chain: Folder[] = [];
  const seen = new Set<string>();
  let current = parentId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const f = c.folders.find((x) => x.id === current);
    if (!f) break;
    chain.unshift(f);
    current = f.parentId;
  }
  return chain;
}

/** All descendant folder and request ids of a folder (inclusive). */
export function descendantIds(c: Collection, folderId: string): { folders: string[]; requests: string[] } {
  const folders = [folderId];
  for (let i = 0; i < folders.length; i++) {
    for (const f of c.folders) if (f.parentId === folders[i] && !folders.includes(f.id)) folders.push(f.id);
  }
  const set = new Set(folders);
  return { folders, requests: c.requests.filter((r) => r.parentId && set.has(r.parentId)).map((r) => r.id) };
}

/** Requests in execution (tree) order, optionally limited to a folder subtree. */
export function requestsInOrder(c: Collection, folderId?: string | null): HttpRequest[] {
  const out: HttpRequest[] = [];
  const byId = new Map(c.requests.map((r) => [r.id, r]));
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'request') {
        const r = byId.get(n.id);
        if (r) out.push(r);
      } else walk(n.children);
    }
  };
  const tree = buildTree(c);
  if (!folderId) walk(tree);
  else {
    const find = (nodes: TreeNode[]): TreeNode | undefined => {
      for (const n of nodes) {
        if (n.id === folderId) return n;
        const f = find(n.children);
        if (f) return f;
      }
      return undefined;
    };
    const node = find(tree);
    if (node) walk(node.children);
  }
  return out;
}

export interface EffectiveRequestConfig {
  /** Merged headers: collection -> folders -> request (later wins per header name, request disabled headers ignored). */
  headers: KeyValue[];
  auth: Auth;
  /** Which level supplied the auth (for UI display). */
  authSource: { level: 'collection' | 'folder' | 'request'; id: string; name: string };
  settings: RequestSettings;
  /** Scripts from outermost to innermost (collection, folders..., request). */
  scripts: Array<{ level: 'collection' | 'folder' | 'request'; name: string; scripts: Scripts }>;
  /** Assertion groups from outermost to innermost. */
  tests: Array<{ level: 'collection' | 'folder' | 'request'; name: string; group: AssertionGroup }>;
  /** Variable layers: collection, folders (outer -> inner), request. */
  variableLayers: Array<{ level: 'collection' | 'folder' | 'request'; name: string; variables: KeyValue[] }>;
}

/** Resolve inherited configuration for a request. Folder settings override collection settings; requests override folders. */
export function resolveEffectiveConfig(c: Collection, request: HttpRequest): EffectiveRequestConfig {
  const folders = ancestorFolders(c, request.parentId);
  const headerMap = new Map<string, KeyValue>();
  const addHeaders = (list: KeyValue[]) => {
    for (const h of list) if (h.enabled && h.key) headerMap.set(h.key.toLowerCase(), h);
  };
  addHeaders(c.headers);
  folders.forEach((f) => addHeaders(f.headers));
  // Request headers keep their own order and override inherited ones.
  const reqHeaders = request.headers.filter((h) => h.enabled && h.key);
  for (const h of reqHeaders) headerMap.delete(h.key.toLowerCase());
  const headers = [...headerMap.values(), ...reqHeaders];

  let auth: Auth = c.auth.type === 'inherit' ? { type: 'none' } : c.auth;
  let authSource: EffectiveRequestConfig['authSource'] = { level: 'collection', id: c.id, name: c.name };
  for (const f of folders) {
    if (f.auth.type !== 'inherit') {
      auth = f.auth;
      authSource = { level: 'folder', id: f.id, name: f.name };
    }
  }
  if (request.auth.type !== 'inherit') {
    auth = request.auth;
    authSource = { level: 'request', id: request.id, name: request.name };
  }

  const settings: RequestSettings = { ...c.settings };
  for (const f of folders) Object.assign(settings, stripUndefined(f.settings));
  Object.assign(settings, stripUndefined(request.settings));

  return {
    headers,
    auth,
    authSource,
    settings,
    scripts: [
      { level: 'collection', name: c.name, scripts: c.scripts },
      ...folders.map((f) => ({ level: 'folder' as const, name: f.name, scripts: f.scripts })),
      { level: 'request', name: request.name, scripts: request.scripts },
    ],
    tests: [
      { level: 'collection', name: c.name, group: c.tests },
      ...folders.map((f) => ({ level: 'folder' as const, name: f.name, group: f.tests })),
      { level: 'request', name: request.name, group: request.tests },
    ],
    variableLayers: [
      { level: 'collection', name: c.name, variables: c.variables },
      ...folders.map((f) => ({ level: 'folder' as const, name: f.name, variables: f.variables })),
      { level: 'request', name: request.name, variables: request.variables },
    ],
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function searchCollection(c: Collection, query: string): HttpRequest[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return c.requests.filter(
    (r) => r.name.toLowerCase().includes(q) || r.url.toLowerCase().includes(q) || r.method.toLowerCase() === q || r.docs.toLowerCase().includes(q),
  );
}
