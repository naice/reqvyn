import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ReqvynError, slugify } from '@reqvyn/shared';
import type { Collection, CollectionSummary, Environment, Folder, HttpRequest } from '@reqvyn/core';
import { FileSystemStore } from '@reqvyn/collection-engine';

export const STORE_DIR = '.reqvyn';

/**
 * Locate the workspace root: the explicit `--workspace` directory, otherwise the nearest ancestor of `cwd`
 * containing a `.reqvyn` folder, otherwise `cwd` itself.
 */
export function findWorkspaceRoot(cwd: string, explicit?: string): string {
  if (explicit) {
    const root = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new ReqvynError('NOT_FOUND', `Workspace folder "${explicit}" does not exist.`);
    return root;
  }
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, STORE_DIR))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

export interface Workspace {
  root: string;
  store: FileSystemStore;
}

export async function openWorkspace(root: string, opts: { create?: boolean } = {}): Promise<Workspace> {
  const dir = join(root, STORE_DIR);
  if (!existsSync(dir) && !opts.create) {
    throw new ReqvynError('NOT_FOUND', `No REQVYN workspace found at ${root}.`, {
      hint: `Expected a "${STORE_DIR}" folder. Use --workspace <dir> or run "reqvyn import <file>" to create one.`,
    });
  }
  const store = new FileSystemStore(dir, { kind: 'workspace', label: 'Workspace' });
  if (opts.create) await store.init();
  return { root, store };
}

const matches = (query: string, item: { id: string; name: string }) => {
  const q = query.trim().toLowerCase();
  return item.id.toLowerCase() === q || item.name.toLowerCase() === q || slugify(item.name) === slugify(query);
};

function pick<T extends { id: string; name: string }>(kind: string, query: string, items: T[], context = ''): T {
  const exact = items.find((i) => i.id === query);
  if (exact) return exact;
  const found = items.filter((i) => matches(query, i));
  if (found.length === 1) return found[0]!;
  if (found.length > 1) {
    throw new ReqvynError('VALIDATION', `"${query}" matches ${found.length} ${kind}s${context}.`, {
      hint: `Use the id instead: ${found.map((f) => `${f.name} (${f.id})`).join(', ')}`,
    });
  }
  const names = items.slice(0, 20).map((i) => i.name).join(', ');
  throw new ReqvynError('NOT_FOUND', `${kind[0]!.toUpperCase()}${kind.slice(1)} "${query}" not found${context}.`, {
    hint: names ? `Available: ${names}${items.length > 20 ? ', …' : ''}` : undefined,
  });
}

export async function findCollection(store: FileSystemStore, query: string): Promise<Collection> {
  const all: CollectionSummary[] = await store.listCollections();
  return store.loadCollection(pick('collection', query, all).id);
}

export async function findEnvironment(store: FileSystemStore, query: string): Promise<Environment> {
  return pick('environment', query, await store.listEnvironments());
}

export function findFolder(c: Collection, query: string): Folder {
  return pick('folder', query, c.folders, ` in collection "${c.name}"`);
}

/** Find a request in one collection, or across all collections when none is given. */
export async function findRequest(store: FileSystemStore, query: string, collectionQuery?: string): Promise<{ collection: Collection; request: HttpRequest }> {
  if (collectionQuery) {
    const collection = await findCollection(store, collectionQuery);
    return { collection, request: pick('request', query, collection.requests, ` in collection "${collection.name}"`) };
  }
  const hits: Array<{ collection: Collection; request: HttpRequest }> = [];
  for (const s of await store.listCollections()) {
    const c = await store.loadCollection(s.id);
    for (const r of c.requests) if (r.id === query || matches(query, r)) hits.push({ collection: c, request: r });
  }
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) throw new ReqvynError('NOT_FOUND', `Request "${query}" not found in any collection.`);
  throw new ReqvynError('VALIDATION', `"${query}" matches ${hits.length} requests.`, {
    hint: `Narrow it down with --collection <name> or use an id: ${hits.map((h) => `${h.collection.name} / ${h.request.name} (${h.request.id})`).join(', ')}`,
  });
}
