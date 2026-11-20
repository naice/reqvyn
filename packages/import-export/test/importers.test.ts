import { describe, expect, it } from 'vitest';
import {
  detectFormat,
  importBruFile,
  importBrunoFiles,
  importBrunoJson,
  importFiles,
  importHoppscotch,
  importHoppscotchEnvironment,
  importInsomnia,
  importOpenApi,
  importPostmanCollection,
  importPostmanEnvironment,
  importReqvyn,
  importText,
  importThunderCollection,
  importThunderEnvironment,
  exportNative,
} from '../src/index.js';
import { createCollection, createRequest, kv } from '@reqvyn/core';
import { byName, expectValid, fixture, fixtureFiles, fixtureJson, folderName, kvMap } from './helpers.js';

describe('Postman v2.1', () => {
  const res = importPostmanCollection(fixtureJson('postman/collection.json'), 'collection.json');
  const c = res.collections[0]!;

  it('produces a valid collection with folders and requests', () => {
    expectValid(res);
    expect(c.name).toBe('Sample Store API');
    expect(c.folders.map((f) => f.name)).toEqual(['Users']);
    expect(c.requests).toHaveLength(5);
    expect(c.auth).toMatchObject({ type: 'bearer', token: '{{token}}' });
    expect(kvMap(c.variables).baseUrl).toBe('https://api.example.test');
    expect(c.meta.source?.type).toBe('postman');
  });

  it('maps path variables, query params and disabled headers', () => {
    const r = byName(c, 'Get user');
    expect(folderName(c, r)).toBe('Users');
    expect(r.method).toBe('GET');
    expect(r.url).toBe('{{baseUrl}}/users/{{id}}');
    expect(r.url).not.toContain('?');
    expect(kvMap(r.params)).toEqual({ expand: 'orders', limit: '10' });
    expect(kvMap(r.variables).id).toBe('42');
    expect(r.headers.find((h) => h.key === 'X-Debug')?.enabled).toBe(false);
    expect(r.scripts.post).toContain('pm.test');
    expect(r.docs).toBe('Fetch one user');
  });

  it('maps bodies and auth', () => {
    const create = byName(c, 'Create user');
    expect(create.body.mode).toBe('json');
    if (create.body.mode === 'json') expect(JSON.parse(create.body.text)).toEqual({ name: 'Ada', email: 'ada@example.test' });
    const login = byName(c, 'Login (form)');
    expect(login.auth.type).toBe('none');
    expect(login.body.mode).toBe('urlencoded');
    if (login.body.mode === 'urlencoded') expect(kvMap(login.body.fields)).toEqual({ username: 'demo', password: '{{password}}' });
    const up = byName(c, 'Upload avatar');
    expect(up.auth).toMatchObject({ type: 'basic', username: 'demo' });
    expect(up.body.mode).toBe('multipart');
    if (up.body.mode === 'multipart') {
      expect(up.body.parts.find((p) => p.key === 'file')).toMatchObject({ type: 'file', filePath: '/tmp/avatar.png' });
      expect(up.body.parts.find((p) => p.key === 'caption')).toMatchObject({ type: 'text', value: 'hello' });
    }
    expect(up.settings.followRedirects).toBe(false);
    expect(up.settings.verifyTls).toBe(false);
  });

  it('warns for every dropped field', () => {
    const codes = res.warnings.map((w) => `${w.code}:${w.field ?? ''}`).join('\n');
    expect(res.warnings.some((w) => /hawk/i.test(w.message))).toBe(true);
    expect(res.warnings.some((w) => /response/i.test(w.message))).toBe(true);
    expect(res.warnings.some((w) => w.code === 'insecure')).toBe(true);
    expect(res.warnings.some((w) => w.code === 'script-needs-adaptation')).toBe(true);
    expect(codes.length).toBeGreaterThan(0);
    for (const w of res.warnings) expect(w.format).toBe('postman');
  });

  it('imports environments and marks secrets', () => {
    const env = importPostmanEnvironment(fixtureJson('postman/environment.json'));
    expectValid(env);
    const e = env.environments[0]!;
    expect(e.name).toBe('Staging');
    expect(e.variables.find((v) => v.key === 'token')?.secret).toBe(true);
    expect(e.variables.find((v) => v.key === 'unused')?.enabled).toBe(false);
  });
});

describe('Thunder Client', () => {
  const res = importThunderCollection(fixtureJson('thunder/collection.json'));
  const c = res.collections[0]!;

  it('imports nested folders regardless of order', () => {
    expectValid(res);
    expect(c.name).toBe('Thunder Sample');
    const nested = c.folders.find((f) => f.name === 'Nested')!;
    const root = c.folders.find((f) => f.name === 'Accounts')!;
    expect(nested.parentId).toBe(root.id);
    expect(c.auth).toMatchObject({ type: 'basic', username: 'demo', password: '{{pass}}' });
    expect(kvMap(c.headers)).toEqual({ 'X-Client': 'thunder' });
  });

  it('maps tests to assertions and set-env-var to extractions', () => {
    const r = byName(c, 'List accounts');
    expect(r.url).toBe('{{host}}/accounts');
    expect(kvMap(r.params)).toEqual({ page: '1' });
    const items = r.tests.items.filter((i) => i.kind === 'assert');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ source: 'status', operator: 'eq', expected: '200' });
    expect(items[1]).toMatchObject({ source: 'json', path: '$.items[0].id' });
    expect(r.extractions[0]).toMatchObject({ variable: 'accountId', source: 'json', path: '$.items[0].id' });
  });

  it('maps path params, bearer auth, body and scripts', () => {
    const g = byName(c, 'Get account');
    expect(g.url).toBe('{{host}}/accounts/{{id}}');
    expect(kvMap(g.variables)).toEqual({ id: '7' });
    expect(g.auth).toMatchObject({ type: 'bearer', token: '{{token}}' });
    const p = byName(c, 'Create account');
    expect(p.body).toMatchObject({ mode: 'json', text: '{"name":"x"}' });
    expect(p.parentId).toBeNull();
    expect(res.warnings.some((w) => w.code === 'script-needs-adaptation')).toBe(true);
  });

  it('imports environments', () => {
    const env = importThunderEnvironment(fixtureJson('thunder/environment.json'));
    expectValid(env);
    expect(env.environments[0]!.name).toBe('Thunder Local');
    expect(env.environments[0]!.variables.find((v) => v.key === 'token')?.secret).toBe(true);
  });
});

describe('Insomnia v4', () => {
  const res = importInsomnia(fixtureJson('insomnia/export.json'));
  const c = res.collections[0]!;

  it('imports workspace, folders, requests and environments', () => {
    expectValid(res);
    expect(c.name).toBe('Insomnia Sample');
    expect(c.folders.map((f) => f.name)).toEqual(['Orders']);
    expect(kvMap(c.variables).base_url).toBe('https://insomnia.example.test');
    expect(res.environments.map((e) => e.name)).toEqual(['Dev']);
    expect(kvMap(res.environments[0]!.variables).base_url).toBe('http://localhost:8080');
  });

  it('converts templates, path params and settings', () => {
    const r = byName(c, 'Get order');
    expect(r.url).toBe('{{base_url}}/orders/{{orderId}}');
    expect(kvMap(r.variables)).toEqual({ orderId: '99' });
    expect(kvMap(r.params)).toEqual({ verbose: 'true' });
    expect(r.params.find((p) => p.key === 'skip')?.enabled).toBe(false);
    expect(r.auth).toMatchObject({ type: 'bearer', token: '{{token}}' });
    expect(r.settings.followRedirects).toBe(false);
  });

  it('imports GraphQL bodies and warns about template tags and unsupported resources', () => {
    const g = byName(c, 'GraphQL search');
    expect(g.body.mode).toBe('graphql');
    if (g.body.mode === 'graphql') {
      expect(g.body.query).toBe('{ items { id } }');
      expect(JSON.parse(g.body.variables)).toEqual({ n: 1 });
    }
    expect(res.warnings.some((w) => /uuid|tag/i.test(w.message) && w.location?.includes('Templated'))).toBe(true);
    expect(res.warnings.some((w) => w.field === 'api_spec')).toBe(true);
  });
});

describe('Bruno', () => {
  it('imports a single .bru file', () => {
    const res = importBruFile(fixture('bruno/single.bru'), 'single.bru');
    expectValid(res);
    const r = res.collections[0]!.requests[0]!;
    expect(r.name).toBe('Get item');
    expect(r.method).toBe('GET');
    expect(r.url).toBe('{{baseUrl}}/items/{{itemId}}');
    expect(r.params.map((p) => [p.key, p.enabled])).toEqual([
      ['view', true],
      ['debug', false],
    ]);
    expect(kvMap(r.variables)).toEqual({ itemId: '5' });
    expect(r.auth).toMatchObject({ type: 'bearer', token: '{{token}}' });
    expect(r.tests.items).toHaveLength(2);
    expect(r.tests.items[0]).toMatchObject({ source: 'status', operator: 'eq', expected: '200' });
    expect(r.tests.items[1]).toMatchObject({ source: 'json', path: '$.id', operator: 'exists' });
    expect(r.extractions[0]).toMatchObject({ variable: 'itemName', source: 'json', path: '$.name' });
    expect(r.scripts.pre).toContain('bru.setVar');
    expect(r.docs).toBe('Returns a single item.');
    expect(res.warnings.some((w) => w.code === 'script-needs-adaptation')).toBe(true);
  });

  it('imports a collection folder (bruno.json, collection.bru, folder.bru, environments)', () => {
    const res = importBrunoFiles(fixtureFiles('bruno/folder'));
    expectValid(res);
    const c = res.collections[0]!;
    expect(c.name).toBe('Bruno Folder');
    expect(c.auth).toMatchObject({ type: 'bearer', token: '{{token}}' });
    expect(kvMap(c.headers)).toEqual({ 'X-App': 'reqvyn-tests' });
    expect(kvMap(c.variables)).toEqual({ apiVersion: 'v1' });
    const folder = c.folders[0]!;
    expect(folder.name).toBe('User Management');
    expect(kvMap(folder.headers)).toEqual({ 'X-Folder': 'users' });
    // seq ordering: create (1) before list (2)
    const inFolder = c.requests.filter((r) => r.parentId === folder.id).sort((a, b) => a.sortKey - b.sortKey);
    expect(inFolder.map((r) => r.name)).toEqual(['Create user', 'List users']);
    const create = byName(c, 'Create user');
    expect(create.body.mode).toBe('json');
    if (create.body.mode === 'json') expect(JSON.parse(create.body.text)).toEqual({ name: 'Grace' });
    const env = res.environments[0]!;
    expect(env.name).toBe('dev');
    expect(env.variables.find((v) => v.key === 'token')).toMatchObject({ secret: true, value: '' });
    expect(res.warnings.some((w) => w.code === 'secret' && w.location?.endsWith('.env'))).toBe(true);
  });

  it('imports a Bruno JSON export without secret environment values', () => {
    const res = importBrunoJson(fixtureJson('bruno/collection.json'));
    expectValid(res);
    const c = res.collections[0]!;
    expect(c.auth).toMatchObject({ type: 'bearer', token: '{{token}}' });
    const make = byName(c, 'Make thing');
    expect(folderName(c, make)).toBe('Things');
    expect(make.body).toMatchObject({ mode: 'json', text: '{"a":1}' });
    expect(make.tests.items[0]).toMatchObject({ source: 'status', expected: '201' });
    expect(make.extractions[0]).toMatchObject({ variable: 'thingId', path: '$.id' });
    expect(byName(c, 'Ping').auth.type).toBe('none');
    const apiKey = res.environments[0]!.variables.find((v) => v.key === 'apiKey')!;
    expect(apiKey.value).toBe('');
    expect(apiKey.secret).toBe(true);
  });
});

describe('Hoppscotch', () => {
  it('imports collections with <<var>> templates', () => {
    const res = importHoppscotch(fixtureJson('hoppscotch/collection.json'));
    expectValid(res);
    const c = res.collections[0]!;
    expect(c.auth).toMatchObject({ type: 'bearer', token: '{{token}}' });
    const find = byName(c, 'Find pet');
    expect(folderName(c, find)).toBe('Pets');
    expect(find.url).toBe('{{baseUrl}}/pets/1');
    expect(find.auth.type).toBe('inherit');
    expect(kvMap(find.params)).toEqual({ fields: 'name' });
    const add = byName(c, 'Add pet');
    expect(add.auth).toMatchObject({ type: 'apikey', key: 'X-API-Key', value: '{{apiKey}}', in: 'header' });
    expect(add.body).toMatchObject({ mode: 'json', text: '{"name":"Rex"}' });
    const login = byName(c, 'Login form');
    expect(login.body.mode).toBe('urlencoded');
    if (login.body.mode === 'urlencoded') expect(kvMap(login.body.fields)).toEqual({ user: 'demo', pass: '{{pass}}' });
    expect(res.warnings.some((w) => w.code === 'script-needs-adaptation')).toBe(true);
  });

  it('imports environments', () => {
    const res = importHoppscotchEnvironment(fixtureJson('hoppscotch/environment.json'));
    expectValid(res);
    expect(res.environments[0]!.name).toBe('Hopp Dev');
    expect(res.environments[0]!.variables.find((v) => v.key === 'apiKey')?.secret).toBe(true);
  });
});

describe('OpenAPI 3.x', () => {
  it('imports YAML with tags, $ref params, servers and security', () => {
    const res = importOpenApi(fixture('openapi/petstore.yaml'), { fileName: 'petstore.yaml' });
    expectValid(res);
    const c = res.collections[0]!;
    expect(c.name).toBe('Pet Store');
    expect(kvMap(c.variables).baseUrl).toBe('https://eu.pets.example.test/v1');
    expect(c.folders.map((f) => f.name)).toEqual(['pets', 'store']);
    expect(c.auth).toMatchObject({ type: 'apikey', key: 'X-API-Key', in: 'header' });
    expect(c.auth.type === 'apikey' && c.auth.value).toMatch(/^\{\{.+\}\}$/);

    const list = byName(c, 'List pets');
    expect(list.method).toBe('GET');
    expect(list.url).toBe('{{baseUrl}}/pets');
    expect(list.params.find((p) => p.key === 'limit')).toMatchObject({ value: '20', enabled: false });
    expect(list.headers.find((h) => h.key === 'X-Trace')).toBeDefined();
    expect(list.meta.openapi).toMatchObject({ operationId: 'listPets', path: '/pets', method: 'GET' });

    const get = byName(c, 'Get pet');
    expect(get.url).toBe('{{baseUrl}}/pets/{{petId}}');
    expect(kvMap(get.variables)).toEqual({ petId: 'abc' });
    expect(get.auth.type).toBe('bearer');
    expect(byName(c, 'Inventory').auth.type).toBe('none');

    const create = byName(c, 'Create pet');
    expect(create.body.mode).toBe('json');
    if (create.body.mode === 'json') expect(JSON.parse(create.body.text)).toMatchObject({ name: 'Rex' });
  });

  it('imports JSON specs with form bodies and examples', () => {
    const res = importText(fixture('openapi/todo.json'), 'todo.json');
    expect(res.format).toBe('openapi');
    expectValid(res);
    const c = res.collections[0]!;
    expect(c.folders).toHaveLength(0);
    const create = c.requests.find((r) => r.meta.openapi?.operationId === 'createTodo')!;
    expect(create.body.mode).toBe('urlencoded');
    if (create.body.mode === 'urlencoded') expect(kvMap(create.body.fields)).toEqual({ title: 'Buy milk' });
    const upd = c.requests.find((r) => r.meta.openapi?.operationId === 'updateTodo')!;
    expect(upd.method).toBe('PATCH');
    expect(upd.url).toBe('{{baseUrl}}/todos/{{id}}');
    if (upd.body.mode === 'json') expect(JSON.parse(upd.body.text)).toEqual({ done: true });
    else expect.fail('expected json body');
  });

  it('rejects Swagger 2.0 with a hint', () => {
    expect(() => importOpenApi({ swagger: '2.0', info: { title: 'x', version: '1' }, paths: {} })).toThrow(/2\.0/);
  });
});

describe('REQVYN native', () => {
  it('round-trips through the native exporter', () => {
    const c = createCollection({ name: 'Native' });
    c.requests.push(createRequest({ name: 'R', method: 'POST', url: 'https://x.test/a', headers: [kv('A', '1')], parentId: null }));
    const text = exportNative(c).text;
    expect(detectFormat(text)).toBe('reqvyn');
    const res = importReqvyn(JSON.parse(text));
    expectValid(res);
    expect(res.collections[0]!.requests[0]).toMatchObject({ name: 'R', method: 'POST', url: 'https://x.test/a' });
  });

  it('rejects future wrapper versions and invalid documents', () => {
    expect(() => importReqvyn({ reqvyn: 'collection', version: 99, collection: {} })).toThrow();
    expect(() => importReqvyn({ reqvyn: 'collection', version: 1, collection: { nope: true } })).toThrow();
  });
});

describe('detectFormat / importFiles', () => {
  it('detects every fixture format', () => {
    expect(detectFormat(fixture('postman/collection.json'))).toBe('postman');
    expect(detectFormat(fixture('postman/environment.json'))).toBe('postman-environment');
    expect(detectFormat(fixture('thunder/collection.json'))).toBe('thunder');
    expect(detectFormat(fixture('thunder/environment.json'))).toBe('thunder-environment');
    expect(detectFormat(fixture('insomnia/export.json'))).toBe('insomnia');
    expect(detectFormat(fixture('bruno/single.bru'))).toBe('bruno');
    expect(detectFormat(fixture('bruno/collection.json'))).toBe('bruno-json');
    expect(detectFormat(fixture('hoppscotch/collection.json'))).toBe('hoppscotch');
    expect(detectFormat(fixture('hoppscotch/environment.json'))).toBe('hoppscotch-environment');
    expect(detectFormat(fixture('openapi/petstore.yaml'))).toBe('openapi');
    expect(detectFormat(fixture('openapi/todo.json'))).toBe('openapi');
    expect(detectFormat(fixture('curl/commands.sh'))).toBe('curl');
    expect(detectFormat('', 'x.reqvyn')).toBe('reqvyn-package');
    expect(detectFormat('swagger: "2.0"\ninfo: {title: x}\n')).toBe('swagger2');
    expect(detectFormat('hello world')).toBe('unknown');
    expect(detectFormat('{"random": true}')).toBe('unknown');
  });

  it('importText throws on unknown formats', () => {
    expect(() => importText('nothing to see', 'notes.txt')).toThrow(/Unrecognized/);
  });

  it('imports many files at once and reports failures as warnings', () => {
    const files = [
      { name: 'postman.json', content: fixture('postman/collection.json') },
      { name: 'env.json', content: fixture('postman/environment.json') },
      { name: 'broken.json', content: '{"info": {"schema": "postman"}, "item": 5' },
      { name: 'readme.txt', content: 'hello' },
      ...fixtureFiles('bruno/folder', 'repo/bruno'),
      { name: 'api.yaml', content: fixture('openapi/petstore.yaml') },
    ];
    const res = importFiles(files);
    expectValid(res);
    expect(res.collections.map((c) => c.name).sort()).toEqual(['Bruno Folder', 'Pet Store', 'Sample Store API']);
    expect(res.environments.map((e) => e.name)).toEqual(expect.arrayContaining(['Staging', 'dev']));
    expect(res.warnings.some((w) => w.location === 'readme.txt' && w.code === 'unknown-file')).toBe(true);
    expect(res.warnings.some((w) => w.location === 'broken.json')).toBe(true);
  });
});
