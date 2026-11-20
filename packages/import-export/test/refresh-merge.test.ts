import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { createAssertion, createCollection, createFolder, createRequest, kv, parseCollection, type Collection } from '@reqvyn/core';
import {
  applyOpenApiRefresh,
  collectionToJson,
  importOpenApi,
  importText,
  mergeCollections,
  parseClipboard,
  planOpenApiRefresh,
  previewImport,
  remapIds,
  requestToPortableJson,
} from '../src/index.js';
import { byName, expectValid, fixture, kvMap } from './helpers.js';

type Spec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function specV2(): Spec {
  const spec = parseYaml(fixture('openapi/petstore.yaml')) as Spec;
  // Changed: new query param on listPets.
  spec.paths['/pets'].get.parameters.push({ name: 'sort', in: 'query', schema: { type: 'string', example: 'name' } });
  // Removed: deletePet.
  delete spec.paths['/pets/{petId}'].delete;
  // Added: updatePet.
  spec.paths['/pets/{petId}'].put = {
    tags: ['pets'],
    operationId: 'updatePet',
    summary: 'Update pet',
    requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } } } },
    responses: { '200': { description: 'ok' } },
  };
  // Added in a new tag.
  spec.tags.push({ name: 'admin' });
  spec.paths['/admin/stats'] = { get: { tags: ['admin'], operationId: 'stats', summary: 'Stats', responses: { '200': { description: 'ok' } } } };
  return spec;
}

function userEdited(): Collection {
  const c = importOpenApi(fixture('openapi/petstore.yaml')).collections[0]!;
  const list = byName(c, 'List pets');
  list.name = 'My pet list';
  list.url = '{{baseUrl}}/pets';
  list.params = list.params.map((p) => (p.key === 'limit' ? { ...p, value: '5', enabled: true } : p));
  list.headers.push(kv('X-Mine', 'keep-me'));
  list.scripts.pre = 'console.log("user script")';
  list.tests.items.push(createAssertion({ source: 'status', operator: 'eq', expected: '200' }));
  list.auth = { type: 'bearer', token: '{{myToken}}', prefix: 'Bearer' };
  const create = byName(c, 'Create pet');
  if (create.body.mode === 'json') create.body = { mode: 'json', text: '{"name":"user body"}' };
  const getPet = byName(c, 'Get pet');
  getPet.url = 'https://custom.host.test/pets/{{petId}}';
  return parseCollection(c);
}

describe('OpenAPI refresh', () => {
  it('reports nothing to do for the same spec', () => {
    const c = importOpenApi(fixture('openapi/petstore.yaml')).collections[0]!;
    const plan = planOpenApiRefresh(c, fixture('openapi/petstore.yaml'));
    expect(plan.added).toHaveLength(0);
    expect(plan.removed).toHaveLength(0);
    expect(plan.changed).toHaveLength(0);
    expect(plan.unchanged).toHaveLength(5);
    expect(plan.preview.split('\n')[0]).toBe('OpenAPI refresh: 0 added, 0 changed, 0 removed, 5 unchanged');
  });

  it('plans added, changed and removed operations', () => {
    const plan = planOpenApiRefresh(userEdited(), stringifyYaml(specV2()));
    expect(plan.added.map((a) => a.request.meta.openapi?.operationId).sort()).toEqual(['stats', 'updatePet']);
    expect(plan.added.find((a) => a.request.meta.openapi?.operationId === 'stats')!.folder).toBe('admin');
    expect(plan.removed.map((r) => r.name)).toEqual(['Delete pet']);
    const changed = plan.changed.find((x) => x.name === 'My pet list')!;
    expect(changed.changes).toContain('query parameter +sort');
    expect(plan.preview).toContain('+ PUT /pets/{petId}');
  });

  it('applies the plan while preserving user edits', () => {
    const before = userEdited();
    const plan = planOpenApiRefresh(before, specV2());
    const res = applyOpenApiRefresh(before, plan);
    const c = res.collection;
    expect(() => parseCollection(c)).not.toThrow();
    expect(res.added).toHaveLength(2);
    expect(res.kept).toEqual([byName(before, 'Delete pet').id]);
    expect(c.requests.some((r) => r.name === 'Delete pet')).toBe(true);

    const list = byName(c, 'My pet list');
    expect(kvMap(list.params)).toMatchObject({ limit: '5' });
    expect(list.params.find((p) => p.key === 'sort')).toBeDefined();
    expect(kvMap(list.headers)).toMatchObject({ 'X-Mine': 'keep-me' });
    expect(list.scripts.pre).toBe('console.log("user script")');
    expect(list.tests.items.some((i) => i.kind === 'assert' && i.source === 'status')).toBe(true);
    expect(list.auth).toMatchObject({ type: 'bearer', token: '{{myToken}}' });
    expect(byName(c, 'Create pet').body).toEqual({ mode: 'json', text: '{"name":"user body"}' });
    expect(byName(c, 'Get pet').url).toBe('https://custom.host.test/pets/{{petId}}');

    const admin = c.folders.find((f) => f.name === 'admin')!;
    expect(byName(c, 'Stats').parentId).toBe(admin.id);
    const pets = c.folders.find((f) => f.name === 'pets')!;
    expect(byName(c, 'Update pet').parentId).toBe(pets.id);
    expect(c.folders.filter((f) => f.name === 'pets')).toHaveLength(1);
  });

  it('removes missing operations only when asked, and can update names', () => {
    const before = userEdited();
    const res = applyOpenApiRefresh(before, planOpenApiRefresh(before, specV2()), { removeMissing: true, updateNames: true });
    expect(res.removed).toEqual([byName(before, 'Delete pet').id]);
    expect(res.collection.requests.some((r) => r.name === 'Delete pet')).toBe(false);
    expect(res.collection.requests.some((r) => r.name === 'List pets')).toBe(true);
  });
});

function target(): Collection {
  const c = createCollection({ name: 'Target', variables: [kv('a', '1')] });
  const f = createFolder({ name: 'Users', parentId: null, sortKey: 0 });
  c.folders.push(f);
  c.requests.push(createRequest({ name: 'List', parentId: f.id, sortKey: 0, method: 'GET', url: 'https://t.test/users' }));
  return parseCollection(c);
}

function source(): Collection {
  const c = createCollection({ name: 'Source', variables: [kv('a', 'other'), kv('b', '2')] });
  const f = createFolder({ name: 'Users', parentId: null, sortKey: 0 });
  c.folders.push(f);
  c.requests.push(
    createRequest({ name: 'List', parentId: f.id, sortKey: 0, method: 'GET', url: 'https://s.test/users' }),
    createRequest({ name: 'New', parentId: null, sortKey: 1, method: 'POST', url: 'https://s.test/new' }),
  );
  return parseCollection(c);
}

describe('merge / preview / remap', () => {
  it('remaps ids consistently', () => {
    const s = source();
    const { collection, idMap } = remapIds(s);
    expect(collection.id).not.toBe(s.id);
    const folder = collection.folders[0]!;
    expect(folder.id).toBe(idMap.get(s.folders[0]!.id));
    expect(collection.requests[0]!.parentId).toBe(folder.id);
    expect(() => parseCollection(collection)).not.toThrow();
    expect(remapIds(s, { keepCollectionId: true }).collection.id).toBe(s.id);
  });

  it('keep-both adds everything', () => {
    const res = mergeCollections(target(), source());
    expect(res.added).toEqual({ folders: 1, requests: 2 });
    expect(res.collection.requests).toHaveLength(3);
    expect(kvMap(res.collection.variables)).toEqual({ a: '1', b: '2' });
  });

  it('overwrite replaces matching requests by folder path + name + method', () => {
    const t = target();
    const res = mergeCollections(t, source(), { strategy: 'overwrite' });
    expect(res.replaced).toBe(1);
    expect(res.added).toEqual({ folders: 0, requests: 1 });
    const list = res.collection.requests.find((r) => r.name === 'List')!;
    expect(list.url).toBe('https://s.test/users');
    expect(list.id).toBe(t.requests[0]!.id);
  });

  it('skip keeps existing requests', () => {
    const res = mergeCollections(target(), source(), { strategy: 'skip' });
    expect(res.skipped).toBe(1);
    expect(res.collection.requests.find((r) => r.name === 'List')!.url).toBe('https://t.test/users');
  });

  it('wraps into a folder', () => {
    const res = mergeCollections(target(), source(), { wrapInFolder: true });
    const wrapper = res.collection.folders.find((f) => f.name === 'Source')!;
    expect(wrapper.parentId).toBeNull();
    expect(res.collection.requests.find((r) => r.name === 'New')!.parentId).toBe(wrapper.id);
  });

  it('previews imports with conflicts and secrets', () => {
    const imported = importText(fixture('postman/collection.json'));
    const existing = createCollection({ name: 'sample store api' });
    const p = previewImport(imported, { collections: [existing] });
    expect(p.collections[0]).toMatchObject({ name: 'Sample Store API', requests: 5, folders: 1, conflict: 'same-name', existingId: existing.id, source: 'postman' });
    expect(p.secrets.length).toBeGreaterThan(0);
    expect(p.summary).toContain('1 collection(s) with 5 request(s)');
    expect(p.summary).toContain('conflict');
  });
});

describe('clipboard', () => {
  it('copies a request as portable JSON without secrets and pastes it back', () => {
    const r = createRequest({ name: 'Copy me', method: 'PUT', url: 'https://c.test/x', auth: { type: 'bearer', token: 'clip-secret-fake', prefix: 'Bearer' } });
    const text = requestToPortableJson(r);
    expect(text).not.toContain('clip-secret-fake');
    const pasted = parseClipboard(text);
    expect(pasted.kind).toBe('request');
    expect(pasted.format).toBe('reqvyn-request');
    expect(pasted.request).toMatchObject({ name: 'Copy me', method: 'PUT', url: 'https://c.test/x' });
    expect(parseClipboard(requestToPortableJson(r, { includeSecrets: true })).secrets.length).toBeGreaterThan(0);
  });

  it('pastes cURL, collections and unknown text', () => {
    const curl = parseClipboard("curl -X POST https://c.test/y -d 'a=1'");
    expect(curl.kind).toBe('request');
    expect(curl.request?.method).toBe('POST');
    const two = parseClipboard('curl https://c.test/1\ncurl https://c.test/2');
    expect(two.kind).toBe('collection');
    expect(two.collections[0]!.requests).toHaveLength(2);
    const col = parseClipboard(collectionToJson(target()));
    expect(col.kind).toBe('collection');
    expectValid(col);
    const pm = parseClipboard(fixture('postman/collection.json'));
    expect(pm.format).toBe('postman');
    expect(parseClipboard('just some words').kind).toBe('unknown');
    expect(parseClipboard('').kind).toBe('unknown');
    const broken = parseClipboard('curl -X POST');
    expect(broken.error).toBeTruthy();
  });
});
