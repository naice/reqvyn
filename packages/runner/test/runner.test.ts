import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemorySecretVault,
  createAssertion,
  createCollection,
  createEnvironment,
  createFolder,
  createRequest,
  decodeBase64Text,
  kv,
  secretKeys,
  type AssertionGroup,
  type Collection,
  type HttpRequest,
} from '@reqvyn/core';
import { newId } from '@reqvyn/shared';
import { ScriptSandboxPool } from '@reqvyn/test-engine';
import { startMockServer, type MockServer } from '../../../tests/helpers/mockServer.js';
import {
  createHistoryEntry,
  createVariableState,
  executeRequest,
  parseCsv,
  parseDataFile,
  runCollection,
  runSucceeded,
  toHtmlReport,
  toJUnitReport,
  toJsonReport,
} from '../src/index.js';

let srv: MockServer;
const pool = new ScriptSandboxPool({ size: 2 });
beforeAll(async () => {
  srv = await startMockServer();
});
afterAll(async () => {
  await srv.close();
  await pool.dispose();
});

const group = (...items: AssertionGroup['items']): AssertionGroup => ({ id: newId(), kind: 'group', enabled: true, logic: 'and', items });
const assertStatus = (code: number) => createAssertion({ source: 'status', operator: 'eq', expected: String(code) });
const body = (r: { response?: { body: { base64: string } } }) => JSON.parse(decodeBase64Text(r.response!.body.base64));

function chainCollection(): Collection {
  const auth = createFolder({ name: 'Auth', sortKey: 1 });
  const login = createRequest({
    name: 'Login',
    method: 'POST',
    parentId: auth.id,
    url: '{{base}}/login',
    sortKey: 1,
    body: { mode: 'json', text: '{"username":"demo","password":"{{password}}"}' },
    extractions: [{ id: newId(), enabled: true, variable: 'token', source: 'json', path: '$.accessToken', scope: 'runtime' }],
    tests: group(assertStatus(200), createAssertion({ source: 'json', path: '$.accessToken', operator: 'exists' })),
  });
  const folder = createFolder({ name: 'Users', sortKey: 2, auth: { type: 'bearer', token: '{{token}}', prefix: 'Bearer' } });
  const create = createRequest({
    name: 'Create user',
    method: 'POST',
    parentId: folder.id,
    sortKey: 1,
    url: '{{base}}/users',
    body: { mode: 'json', text: '{"name":"{{userName}}"}' },
    extractions: [{ id: newId(), enabled: true, variable: 'userId', source: 'json', path: '$.id', scope: 'runtime' }],
    tests: group(assertStatus(201), createAssertion({ source: 'json', path: '$.name', operator: 'eq', expected: '{{userName}}' })),
  });
  const get = createRequest({
    name: 'Get user',
    parentId: folder.id,
    sortKey: 2,
    url: '{{base}}/users/{{userId}}',
    tests: group(assertStatus(200)),
    scripts: { pre: '', post: "reqvyn.test('has id', () => reqvyn.expect(reqvyn.response.json().id).toBe(reqvyn.variables.get('userId')));" },
  });
  return createCollection({
    name: 'Chain',
    variables: [kv('base', srv.url), kv('userName', 'Ada')],
    headers: [kv('X-Collection', 'yes')],
    folders: [auth, folder],
    requests: [login, create, get],
  });
}

describe('executeRequest', () => {
  it('resolves variables, inherited headers and secrets from the vault', async () => {
    const env = createEnvironment({ name: 'Dev', variables: [kv('apiKey', '', { secret: true }), kv('who', 'env')] });
    const vault = new MemorySecretVault({ [secretKeys.environmentVariable(env.id, 'apiKey')]: 'k-123456', [secretKeys.named('extra')]: 'named-999' });
    const req = createRequest({
      name: 'Echo',
      url: '{{base}}/echo',
      params: [kv('who', '{{who}}'), kv('off', 'x', { enabled: false })],
      headers: [kv('X-Key', '{{apiKey}}'), kv('X-Named', '{{$secret:extra}}')],
    });
    const c = createCollection({ name: 'C', variables: [kv('base', srv.url), kv('who', 'collection')], headers: [kv('X-Collection', '1')], requests: [req] });
    const r = await executeRequest({ collection: c, request: req, environment: env }, { vault });
    expect(r.error).toBeUndefined();
    const b = body(r);
    expect(b.query).toEqual({ who: 'env' });
    expect(b.headers['x-key']).toBe('k-123456');
    expect(b.headers['x-named']).toBe('named-999');
    expect(b.headers['x-collection']).toBe('1');
    // the sent request shown in the UI is redacted
    expect(JSON.stringify(r.response!.sentRequest)).not.toContain('k-123456');
    expect(JSON.stringify(r.response!.sentRequest)).not.toContain('named-999');
  });

  it('runs pre-request scripts before variable resolution', async () => {
    const req = createRequest({
      url: '{{base}}/echo/{{fromScript}}',
      scripts: { pre: "reqvyn.variables.set('fromScript', 'abc'); reqvyn.request.headers.set('X-Pre', '{{fromScript}}');", post: '' },
    });
    const c = createCollection({ variables: [kv('base', srv.url)], requests: [req] });
    const r = await executeRequest({ collection: c, request: req }, { sandbox: pool });
    expect(r.error).toBeUndefined();
    const b = body(r);
    expect(b.path).toBe('/echo/abc');
    expect(b.headers['x-pre']).toBe('abc');
    expect(r.variableChanges).toContainEqual({ scope: 'runtime', key: 'fromScript', value: 'abc' });
  });

  it('honours skipRequest and reports script errors', async () => {
    const skip = createRequest({ url: '{{base}}/echo', scripts: { pre: 'reqvyn.skipRequest()', post: '' } });
    const c = createCollection({ variables: [kv('base', srv.url)], requests: [skip] });
    expect((await executeRequest({ collection: c, request: skip }, { sandbox: pool })).skipped).toBe(true);
    const bad = createRequest({ url: '{{base}}/echo', scripts: { pre: 'throw new Error("boom")', post: '' } });
    const r = await executeRequest({ collection: c, request: bad }, { sandbox: pool });
    expect(r.error?.code).toBe('SCRIPT');
    expect(r.error?.message).toMatch(/boom/);
    expect(r.response).toBeUndefined();
  });

  it('does not run scripts when disabled (untrusted workspace)', async () => {
    const req = createRequest({ url: '{{base}}/echo', scripts: { pre: "reqvyn.variables.set('x','1')", post: '' } });
    const c = createCollection({ variables: [kv('base', srv.url)], requests: [req] });
    const r = await executeRequest({ collection: c, request: req }, { scripts: { enabled: false } });
    expect(r.error).toBeUndefined();
    expect(r.variableChanges).toEqual([]);
    expect(r.console.some((e) => e.level === 'warn' && /disabled/.test(e.message))).toBe(true);
  });

  it('performs digest authentication with a challenge round trip', async () => {
    const req = createRequest({ url: '{{base}}/digest-auth/u/p', auth: { type: 'digest', username: 'u', password: '{{pw}}' } });
    const c = createCollection({ variables: [kv('base', srv.url), kv('pw', 'p')], requests: [req] });
    const r = await executeRequest({ collection: c, request: req });
    expect(r.response?.status).toBe(200);
    expect(r.response?.timeline.some((t) => /Digest challenge/.test(t.message))).toBe(true);
  });

  it('prepares urlencoded, graphql and text bodies', async () => {
    const c = createCollection({ variables: [kv('base', srv.url), kv('v', 'a b&c')] });
    const form = createRequest({ method: 'POST', url: '{{base}}/echo', body: { mode: 'urlencoded', fields: [kv('k', '{{v}}')] } });
    let b = body(await executeRequest({ collection: c, request: form }));
    expect(b.body).toBe('k=a+b%26c');
    expect(b.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const gql = createRequest({ method: 'POST', url: '{{base}}/echo', body: { mode: 'graphql', query: 'query { me }', variables: '{"x":"{{v}}"}' } });
    b = body(await executeRequest({ collection: c, request: gql }));
    expect(b.json).toEqual({ query: 'query { me }', variables: { x: 'a b&c' } });
    const custom = createRequest({ method: 'POST', url: '{{base}}/echo', headers: [kv('Content-Type', 'text/csv')], body: { mode: 'text', text: 'a,b' } });
    b = body(await executeRequest({ collection: c, request: custom }));
    expect(b.headers['content-type']).toBe('text/csv');
  });

  it('reports errors without throwing and notes unresolved variables', async () => {
    const req = createRequest({ url: 'http://127.0.0.1:1/{{missing}}' });
    const r = await executeRequest({ request: req });
    expect(r.error?.code).toBe('CONNECTION');
    const ok = createRequest({ url: `${srv.url}/echo?x={{nope}}` });
    const r2 = await executeRequest({ request: ok });
    expect(r2.response?.timeline.some((t) => t.message.includes('{{nope}}'))).toBe(true);
  });

  it('creates history entries without secrets', async () => {
    const req = createRequest({ url: `${srv.url}/echo`, headers: [kv('X-Secret', 'hidden', { secret: true })], auth: { type: 'basic', username: 'u', password: 'literal-pw' } });
    const r = await executeRequest({ request: req });
    const h = createHistoryEntry(req, r);
    expect(h.status).toBe(200);
    expect(JSON.stringify(h)).not.toContain('literal-pw');
    expect(JSON.stringify(h)).not.toContain('hidden');
  });
});

describe('runCollection', () => {
  it('chains requests through extractions, inherited auth, assertions and scripts', async () => {
    const env = createEnvironment({ name: 'Dev', variables: [kv('password', '', { secret: true })] });
    const vault = new MemorySecretVault({ [secretKeys.environmentVariable(env.id, 'password')]: 'secret' });
    const progress: number[] = [];
    const report = await runCollection({ collection: chainCollection(), environment: env, onProgress: (p) => progress.push(p.completed) }, { vault, sandbox: pool });
    expect(report.results.map((r) => [r.requestName, r.status])).toEqual([
      ['Login', 'passed'],
      ['Create user', 'passed'],
      ['Get user', 'passed'],
    ]);
    expect(runSucceeded(report)).toBe(true);
    expect(report.summary.assertions.failed).toBe(0);
    expect(progress.at(-1)).toBe(3);
    const json = toJsonReport(report);
    expect(json).not.toContain('"secret"');
    expect(json).not.toContain('rawVariableChanges');
  });

  it('runs data-driven iterations, skips and stops on failure', async () => {
    const c = chainCollection();
    const rows = parseCsv('userName,password\n"Lovelace, Ada",secret\nGrace,wrong\nAlan,secret\n');
    expect(rows[0]).toEqual({ userName: 'Lovelace, Ada', password: 'secret' });
    const report = await runCollection({ collection: c, data: rows, stopOnFailure: true }, { sandbox: pool });
    expect(report.iterations).toBe(3);
    // Iteration 1 passes, iteration 2 fails at login → stop.
    expect(report.results.filter((r) => r.iteration === 1).every((r) => r.status === 'passed')).toBe(true);
    expect(report.results.at(-1)).toMatchObject({ iteration: 2, requestName: 'Login', status: 'failed' });
    expect(runSucceeded(report)).toBe(false);

    const skipped = await runCollection({ collection: c, skip: [c.requests[2]!.id], iterations: 2, data: undefined }, { scripts: { enabled: false } });
    expect(skipped.results.filter((r) => r.status === 'skipped')).toHaveLength(2);
  });

  it('supports concurrency, delays and cancellation', async () => {
    const reqs: HttpRequest[] = Array.from({ length: 6 }, (_, i) => createRequest({ name: `slow ${i}`, url: `${srv.url}/delay/150`, sortKey: i }));
    const c = createCollection({ name: 'Slow', requests: reqs });
    const t0 = Date.now();
    const parallel = await runCollection({ collection: c, concurrency: 6 });
    expect(parallel.summary.passed).toBe(6);
    expect(Date.now() - t0).toBeLessThan(800);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const cancelled = await runCollection({ collection: c, delayMs: 50, signal: ac.signal });
    expect(cancelled.summary.cancelled).toBe(true);
    expect(cancelled.results.length).toBeLessThan(6);
  });

  it('keeps run variables between requests and lets hosts persist changes', async () => {
    const setter = createRequest({ name: 'set', url: `${srv.url}/echo`, sortKey: 1, extractions: [{ id: newId(), enabled: true, variable: 'm', source: 'json', path: '$.method', scope: 'environment' }] });
    const reader = createRequest({ name: 'read', url: `${srv.url}/echo/{{m}}`, sortKey: 2 });
    const env = createEnvironment({ name: 'E', variables: [kv('m', 'old')] });
    const persisted: unknown[] = [];
    const state = createVariableState();
    const report = await runCollection(
      { collection: createCollection({ requests: [setter, reader] }), environment: env, state, onResult: (o) => void persisted.push(...o.rawVariableChanges) },
      {},
    );
    expect(body(report.results[1]!).path).toBe('/echo/GET');
    expect(persisted).toEqual([{ scope: 'environment', key: 'm', value: 'GET' }]);
    expect(state.environment.get('m')).toBe('GET');
  });

  it('renders JUnit and HTML reports with escaping', async () => {
    const req = createRequest({ name: 'Bad <name> & "quotes"', url: `${srv.url}/status/500`, tests: group(assertStatus(200)) });
    const report = await runCollection({ collection: createCollection({ name: 'R&D', requests: [req] }) });
    const junit = toJUnitReport(report);
    expect(junit).toContain('<testsuites name="R&amp;D"');
    expect(junit).toContain('Bad &lt;name&gt; &amp; &quot;quotes&quot;');
    expect(junit).toMatch(/<failure message="Expected Status to equal/);
    const html = toHtmlReport(report);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain('<name>');
    expect(html).not.toMatch(/<script/i);
  });
});

describe('data files', () => {
  it('parses CSV edge cases and JSON arrays', () => {
    expect(parseCsv('﻿a,b\r\n1,"x ""q"" y"\r\n2,\n')).toEqual([
      { a: '1', b: 'x "q" y' },
      { a: '2', b: '' },
    ]);
    expect(parseCsv('a\n"multi\nline"\n')).toEqual([{ a: 'multi\nline' }]);
    expect(() => parseCsv('a\n"open')).toThrow(/unterminated/);
    expect(parseDataFile('d.json', '[{"n":1,"o":{"x":true},"z":null}]')).toEqual([{ n: '1', o: '{"x":true}', z: '' }]);
    expect(() => parseDataFile('d.json', '{"a":1}')).toThrow(/array/);
    expect(() => parseDataFile('d.xml', '')).toThrow(/Unsupported/);
  });
});
