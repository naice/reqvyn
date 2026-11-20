import * as vscode from 'vscode';
import { createCollection, type Collection } from '@reqvyn/core';
import { newId } from '@reqvyn/shared';
import type { StoreEntry, StoreManager } from './stores.js';

export interface CollectionTarget {
  entry: StoreEntry;
  collection: Collection;
  folderId: string | null;
}

/** Ask where to store something: an existing collection (optionally a folder) or a new collection. */
export async function pickCollectionTarget(stores: StoreManager, opts: { title: string; allowFolder?: boolean }): Promise<CollectionTarget | undefined> {
  type Item = vscode.QuickPickItem & { entry?: StoreEntry; collectionId?: string; create?: StoreEntry };
  const items: Item[] = [];
  for (const entry of stores.list()) {
    items.push({ label: entry.label, kind: vscode.QuickPickItemKind.Separator });
    for (const c of await entry.store.listCollections()) items.push({ label: `$(folder-library) ${c.name}`, description: `${c.requestCount} requests`, entry, collectionId: c.id });
    items.push({ label: `$(add) New collection in ${entry.label}…`, create: entry });
  }
  const choice = await vscode.window.showQuickPick(items, { title: opts.title, placeHolder: 'Select a collection' });
  if (!choice) return undefined;
  if (choice.create) {
    const name = await vscode.window.showInputBox({ title: 'New collection', prompt: 'Collection name', value: 'New Collection', validateInput: (v) => (v.trim() ? undefined : 'Enter a name') });
    if (!name) return undefined;
    const collection = createCollection({ id: newId(), name: name.trim() });
    await choice.create.store.saveCollection(collection);
    return { entry: choice.create, collection, folderId: null };
  }
  if (!choice.entry || !choice.collectionId) return undefined;
  const collection = await choice.entry.store.loadCollection(choice.collectionId);
  let folderId: string | null = null;
  if (opts.allowFolder && collection.folders.length) {
    const paths = folderPaths(collection);
    const f = await vscode.window.showQuickPick([{ label: '$(root-folder) (collection root)', id: null as string | null }, ...paths.map((p) => ({ label: `$(folder) ${p.path}`, id: p.id as string | null }))], {
      title: opts.title,
      placeHolder: 'Select a folder',
    });
    if (!f) return undefined;
    folderId = f.id;
  }
  return { entry: choice.entry, collection, folderId };
}

/** Human-readable folder paths ("Users / Admin"). */
export function folderPaths(c: Collection): Array<{ id: string; path: string }> {
  const byId = new Map(c.folders.map((f) => [f.id, f]));
  const pathOf = (id: string): string => {
    const parts: string[] = [];
    let cur = byId.get(id);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.join(' / ');
  };
  return c.folders.map((f) => ({ id: f.id, path: pathOf(f.id) })).sort((a, b) => a.path.localeCompare(b.path));
}

/** Pick a store (only asks when more than one exists). */
export async function pickStore(stores: StoreManager, title: string): Promise<StoreEntry | undefined> {
  const list = stores.list();
  if (list.length === 1) return list[0];
  const choice = await vscode.window.showQuickPick(
    list.map((entry) => ({ label: entry.label, description: entry.kind === 'workspace' ? 'shared via .reqvyn/' : 'only on this machine', entry })),
    { title },
  );
  return choice?.entry;
}
