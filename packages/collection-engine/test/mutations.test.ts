import { describe, expect, it } from 'vitest';
import { createCollection, createRequest, createAuth, requestsInOrder, type Collection } from './helpers.js';
import { addFolder, addRequest, deleteNode, duplicateFolder, duplicateRequest, moveNode, renameNode, moveToCollection, extractInlineAuthSecrets, hasInlineSecrets, stripSecretValues } from '../src/index.js';

function base(): Collection {
  return createCollection({ name: 'C' });
}

describe('mutations', () => {
  it('adds requests and folders with unique names and increasing sort keys', () => {
    let c = base();
    const f = addFolder(c, 'Users');
    c = f.collection;
    const a = addRequest(c, { name: 'Get' }, f.folder.id);
    c = a.collection;
    const b = addRequest(c, { name: 'Get' }, f.folder.id);
    c = b.collection;
    expect(b.request.name).toBe('Get 2');
    expect(b.request.sortKey).toBeGreaterThan(a.request.sortKey);
    expect(() => addRequest(c, {}, 'missing')).toThrow(/not found/);
  });

  it('renames and validates', () => {
    const { collection, request } = addRequest(base(), { name: 'A' });
    expect(renameNode(collection, request.id, ' B ').collection.requests[0]!.name).toBe('B');
    expect(() => renameNode(collection, request.id, '  ')).toThrow();
  });

  it('deletes folders recursively', () => {
    let c = base();
    const f1 = addFolder(c, 'F1');
    c = f1.collection;
    const f2 = addFolder(c, 'F2', f1.folder.id);
    c = f2.collection;
    c = addRequest(c, { name: 'deep' }, f2.folder.id).collection;
    c = addRequest(c, { name: 'top' }).collection;
    const r = deleteNode(c, f1.folder.id);
    expect(r.collection.folders).toHaveLength(0);
    expect(r.collection.requests.map((x) => x.name)).toEqual(['top']);
    expect(r.removedFolders.sort()).toEqual([f1.folder.id, f2.folder.id].sort());
  });

  it('duplicates requests and folders (deep, new ids)', () => {
    let c = base();
    const f = addFolder(c, 'F');
    c = f.collection;
    const sub = addFolder(c, 'Sub', f.folder.id);
    c = sub.collection;
    const req = addRequest(c, { name: 'R' }, sub.folder.id);
    c = req.collection;
    const d = duplicateFolder(c, f.folder.id);
    expect(d.collection.folders).toHaveLength(4);
    expect(d.collection.requests).toHaveLength(2);
    expect(new Set(d.collection.requests.map((r) => r.id)).size).toBe(2);
    expect(d.folder.name).toBe('F Copy');
    const dr = duplicateRequest(c, req.request.id);
    expect(dr.request.name).toBe('R Copy');
    // copy placed right after the original
    const order = requestsInOrder(dr.collection).map((r) => r.name);
    expect(order).toEqual(['R', 'R Copy']);
  });

  it('moves and reorders, preventing cycles', () => {
    let c = base();
    const a = addRequest(c, { name: 'A' });
    c = a.collection;
    const b = addRequest(c, { name: 'B' });
    c = b.collection;
    const f = addFolder(c, 'F');
    c = f.collection;
    const sub = addFolder(c, 'Sub', f.folder.id);
    c = sub.collection;
    c = moveNode(c, b.request.id, null, a.request.id).collection;
    expect(requestsInOrder(c).map((r) => r.name)).toEqual(['B', 'A']);
    c = moveNode(c, a.request.id, sub.folder.id).collection;
    expect(c.requests.find((r) => r.id === a.request.id)!.parentId).toBe(sub.folder.id);
    expect(() => moveNode(c, f.folder.id, sub.folder.id)).toThrow(/cannot be moved/);
    expect(() => moveNode(c, f.folder.id, f.folder.id)).toThrow(/cannot be moved/);
  });

  it('moves items across collections', () => {
    let src = base();
    const f = addFolder(src, 'F');
    src = f.collection;
    src = addRequest(src, { name: 'R' }, f.folder.id).collection;
    const { source, target } = moveToCollection(src, base(), f.folder.id);
    expect(source.folders).toHaveLength(0);
    expect(source.requests).toHaveLength(0);
    expect(target.folders).toHaveLength(1);
    expect(target.requests).toHaveLength(1);
  });
});

describe('secret helpers', () => {
  it('extracts literal auth secrets into references', () => {
    const auth = createAuth({ type: 'basic', username: 'u', password: 'p@ss' });
    expect(hasInlineSecrets(auth)).toBe(true);
    const r = extractInlineAuthSecrets(auth, 'req1');
    expect(r.secrets).toEqual([{ name: 'auth.req1.password', value: 'p@ss', field: 'password' }]);
    expect((r.auth as { password: string }).password).toBe('{{$secret:auth.req1.password}}');
    expect(hasInlineSecrets(r.auth)).toBe(false);
    const templ = createAuth({ type: 'bearer', token: '{{token}}' });
    expect(extractInlineAuthSecrets(templ, 'x').secrets).toEqual([]);
  });

  it('strips secret row values', () => {
    const req = createRequest({ headers: [{ id: '1', key: 'X-Key', value: 'v', enabled: true, secret: true }] });
    expect(stripSecretValues(req).headers[0]!.value).toBe('');
  });
});
