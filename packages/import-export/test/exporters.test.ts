import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createAssertion, createCollection, createEnvironment, createFolder, createRequest, kv, parseCollection, type Collection, type HttpRequest } from '@reqvyn/core';
import {
  POSTMAN_SCHEMA_V21,
  exportCurlScript,
  exportNative,
  exportOpenApi,
  exportPostman,
  exportPostmanEnvironment,
  importOpenApi,
  importPostmanCollection,
  importPostmanEnvironment,
  urlToPath,
} from '../src/index.js';
import { expectValid, kvMap } from './helpers.js';

function stripIds(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (k, val: unknown) => (k === 'id' ? undefined : val))) as unknown;
}

function sampleCollection(): Collection {
  const c = createCollection({ name: 'Round Trip', variables: [kv('baseUrl', 'https://rt.example.test')], auth: { type: 'bearer', token: '{{token}}', prefix: 'Bearer' } });
  const folder = createFolder({ name: 'Users', parentId: null, sortKey: 0 });
  c.folders.push(folder);
  const reqs: HttpRequest[] = [
    createRequest({
      name: 'Get user',
      parentId: folder.id,
      sortKey: 0,
      method: 'GET',
      url: '{{baseUrl}}/users/{{id}}',
      variables: [kv('id', '42')],
      params: [kv('expand', 'orders'), kv('off', '1', { enabled: false })],
      headers: [kv('Accept', 'application/json'), kv('X-Trace', 'abc')],
      tests: { ...createCollection({ name: 'x' }).tests, items: [createAssertion({ source: 'status', operator: 'eq', expected: '200' })] },
    }),
    createRequest({
      name: 'Create user',
      parentId: folder.id,
      sortKey: 1,
      method: 'POST',
      url: '{{baseUrl}}/users',
      headers: [kv('Content-Type', 'application/json')],
      body: { mode: 'json', text: '{\n  "name": "Ada"\n}' },
    }),
    createRequest({
      name: 'Login',
      parentId: null,
      sortKey: 1,
      method: 'POST',
      url: '{{baseUrl}}/login',
      body: { mode: 'urlencoded', fields: [kv('user', 'demo'), kv('pass', '{{password}}')] },
      auth: { type: 'none' },
    }),
    createRequest({
      name: 'Upload',
      parentId: null,
      sortKey: 2,
      method: 'PUT',
      url: '{{baseUrl}}/files',
      body: {
        mode: 'multipart',
        parts: [
          { id: 'p1', key: 'title', enabled: true, type: 'text', value: 'Hello' },
          { id: 'p2', key: 'file', enabled: true, type: 'file', value: '', filePath: '/data/a.png' },
        ],
      },
      auth: { type: 'basic', username: 'demo', password: 'hunter2-fake' },
    }),
    createRequest({
      name: 'GraphQL',
      parentId: null,
      sortKey: 3,
      method: 'POST',
      url: '{{baseUrl}}/graphql',
      body: { mode: 'graphql', query: '{ me { id } }', variables: '{"a":1}' },
    }),
  ];
  c.requests.push(...reqs);
  return parseCollection(c);
}

describe('REQVYN -> Postman -> REQVYN round-trip', () => {
  const original = sampleCollection();
  const exported = exportPostman(original, { includeSecrets: true });
  const back = importPostmanCollection(JSON.parse(exported.text)).collections[0]!;

  it('emits a v2.1 document', () => {
    expect(exported.data?.info.schema).toBe(POSTMAN_SCHEMA_V21);
    expect(exported.text).toContain(':id');
  });

  it('preserves method, url, params, headers and body for every request', () => {
    expectValid({ collections: [back], environments: [], warnings: [] });
    expect(back.folders.map((f) => f.name)).toEqual(['Users']);
    for (const r of original.requests) {
      const b = back.requests.find((x) => x.name === r.name)!;
      expect(b, r.name).toBeDefined();
      expect(b.method).toBe(r.method);
      expect(b.url).toBe(r.url);
      expect(b.params.map((p) => [p.key, p.value, p.enabled])).toEqual(r.params.map((p) => [p.key, p.value, p.enabled]));
      expect(kvMap(b.headers)).toEqual(kvMap(r.headers));
      expect(stripIds(b.body)).toEqual(stripIds(r.body));
      expect(b.auth).toEqual(r.auth);
    }
    expect(kvMap(back.requests.find((x) => x.name === 'Get user')!.variables)).toEqual({ id: '42' });
    expect(back.auth).toEqual(original.auth);
  });

  it('converts assertions to pm.test scripts with a warning', () => {
    expect(back.requests.find((x) => x.name === 'Get user')!.scripts.post).toContain('pm.test');
    expect(exported.warnings.some((w) => w.code === 'converted')).toBe(true);
  });

  it('blanks secrets by default', () => {
    const safe = exportPostman(original);
    expect(safe.text).not.toContain('hunter2-fake');
    expect(safe.removed.length).toBeGreaterThan(0);
    expect(safe.warnings.some((w) => w.code === 'secret')).toBe(true);
  });

  it('exports environments without values unless asked', () => {
    const env = createEnvironment({ name: 'Prod', variables: [kv('baseUrl', 'https://prod.test'), kv('token', 'secret-token-fake', { secret: true })] });
    const tmpl = exportPostmanEnvironment(env);
    expect(tmpl.text).not.toContain('secret-token-fake');
    expect(tmpl.text).toContain('https://prod.test');
    const full = exportPostmanEnvironment(env, { includeEnvironmentValues: true });
    expect(full.text).toContain('https://prod.test');
    expect(full.text).not.toContain('secret-token-fake');
    const back2 = importPostmanEnvironment(JSON.parse(full.text)).environments[0]!;
    expect(back2.variables.find((v) => v.key === 'token')?.secret).toBe(true);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

describe('OpenAPI exporter', () => {
  it('maps URLs to paths', () => {
    expect(urlToPath('{{baseUrl}}/users/{{id}}/posts')).toMatchObject({ path: '/users/{id}/posts', pathParams: ['id'] });
    expect(urlToPath('https://api.test/v1/a').path).toBe('/v1/a');
  });

  it('exports a valid-looking 3.0 document that re-imports', () => {
    const res = exportOpenApi(sampleCollection(), { format: 'yaml' });
    const doc = parseYaml(res.text) as Doc;
    expect(doc.openapi).toMatch(/^3\.0/);
    expect(doc.info.title).toBe('Round Trip');
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/users/{id}', '/users', '/login', '/files', '/graphql']));
    const get = doc.paths['/users/{id}'].get;
    expect(get.tags).toEqual(['Users']);
    expect(get.parameters.some((p: { in: string; name: string }) => p.in === 'path' && p.name === 'id')).toBe(true);
    expect(get.parameters.some((p: { in: string; name: string }) => p.in === 'query' && p.name === 'expand')).toBe(true);
    expect(doc.paths['/users'].post.requestBody.content['application/json']).toBeDefined();
    expect(doc.components.securitySchemes).toBeDefined();
    const again = importOpenApi(res.text);
    expectValid(again);
    expect(again.collections[0]!.requests.length).toBe(5);
  });
});

describe('cURL script & native exporters', () => {
  it('exports a cURL script for a collection', () => {
    const res = exportCurlScript(sampleCollection());
    expect(res.text.match(/^curl /gm)?.length).toBe(5);
    expect(res.text.startsWith('#!/bin/sh')).toBe(true);
    expect(res.text).toContain("curl '{{baseUrl}}/users/{{id}}?expand=orders'");
    expect(res.text).toContain("-H 'Authorization: Bearer {{token}}'");
    expect(res.text).toContain("-u 'demo:<PASSWORD>'");
    expect(res.text).not.toContain('hunter2-fake');
  });

  it('exports native JSON with environments as templates', () => {
    const env = createEnvironment({ name: 'E', variables: [kv('a', 'value-a'), kv('s', 'top-secret-fake', { secret: true })] });
    const res = exportNative(sampleCollection(), { environments: [env] });
    expect(res.text).not.toContain('hunter2-fake');
    expect(res.text).not.toContain('top-secret-fake');
    expect(res.text).toContain('value-a');
    expect(res.data?.environments?.[0]?.variables.map((v) => v.key)).toEqual(['a', 's']);
    const withSecrets = exportNative(sampleCollection(), { environments: [env], includeSecrets: true });
    expect(withSecrets.text).toContain('top-secret-fake');
    expect(withSecrets.text).toContain('hunter2-fake');
  });
});
