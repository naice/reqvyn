import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssertion, createCollection, createEnvironment, createFolder, createRequest, kv, type AssertionGroup } from '@reqvyn/core';
import { FileSystemStore } from '@reqvyn/collection-engine';
import { newId } from '@reqvyn/shared';
import { startMockServer, type MockServer } from '../../../tests/helpers/mockServer.js';
import { EnvSecretVault, McpServer, main, parseArgs, RUN_OPTIONS, type CliIO } from '../src/index.js';

let srv: MockServer;
let dir: string;
beforeAll(async () => {
  srv = await startMockServer();
});
afterAll(async () => srv.close());
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reqvyn-cli-'));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

const group = (...items: AssertionGroup['items']): AssertionGroup => ({ id: newId(), kind: 'group', enabled: true, logic: 'and', items });

function io(env: Record<string, string> = {}): CliIO & { out: string; err: string } {
  const o = { out: '', err: '', cwd: dir, env, color: false } as CliIO & { out: string; err: string };
  o.stdout = (t) => void (o.out += t);
  o.stderr = (t) => void (o.err += t);
  return o;
}

async function seed() {
  const store = new FileSystemStore(join(dir, '.reqvyn'));
  await store.init();
  const auth = createFolder({ name: 'Auth', sortKey: 1 });
  const users = createFolder({ name: 'Users', sortKey: 2, auth: { type: 'bearer', token: '{{token}}', prefix: 'Bearer' } });
  const login = createRequest({
    name: 'Login',
    method: 'POST',
    parentId: auth.id,
    url: '{{base}}/login',
    body: { mode: 'json', text: '{"username":"{{user}}","password":"{{password}}"}' },
    extractions: [{ id: newId(), enabled: true, variable: 'token', source: 'json', path: '$.accessToken', scope: 'runtime' }],
    tests: group(createAssertion({ source: 'status', operator: 'eq', expected: '200' })),
  });
  const list = createRequest({ name: 'List users', parentId: users.id, url: '{{base}}/users', tests: group(createAssertion({ source: 'status', operator: 'eq', expected: '200' })) });
  const collection = createCollection({ name: 'Users API', variables: [kv('base', srv.url), kv('user', 'demo')], folders: [auth, users], requests: [login, list] });
  const env = createEnvironment({ name: 'Staging', variables: [kv('password', '', { secret: true })] });
  await store.saveCollection(collection);
  await store.saveEnvironment(env);
  store.dispose();
  return { collection, env };
}

describe('reqvyn CLI', () => {
  it('prints help and version', async () => {
    const x = io();
    expect(await main([], x)).toBe(0);
    expect(x.out).toContain('reqvyn <command>');
    expect(await main(['run', '--help'], x)).toBe(0);
    expect(x.out).toContain('--report');
    expect(await main(['nope'], x)).toBe(2);
    expect(x.err).toContain('Unknown command');
  });

  it('runs a collection with secrets from CI environment variables and writes reports', async () => {
    await seed();
    const x = io({ REQVYN_SECRET_STAGING_PASSWORD: 'secret' });
    const code = await main(['run', 'collection', 'users-api', '--env', 'staging', '--report', 'cli,json,junit,html', '--out', 'out'], x);
    expect(x.err).toBe('');
    expect(code).toBe(0);
    expect(x.out).toMatch(/✓ POST\s+Login 200/);
    expect(x.out).toMatch(/2 passed, 0 failed/);
    const json = JSON.parse(await readFile(join(dir, 'out', 'reqvyn-report.json'), 'utf8'));
    expect(json.summary.passed).toBe(2);
    expect(await readFile(join(dir, 'out', 'reqvyn-junit.xml'), 'utf8')).toContain('<testsuites');
    expect(existsSync(join(dir, 'out', 'reqvyn-report.html'))).toBe(true);
    for (const f of readdirSync(join(dir, 'out'))) expect(readFileSync(join(dir, 'out', f), 'utf8')).not.toContain('"secret"');
  });

  it('fails with exit code 1 when tests fail and 2 for unknown targets', async () => {
    await seed();
    const x = io({ REQVYN_SECRET_PASSWORD: 'wrong' });
    expect(await main(['run', 'Users API', '-e', 'Staging', '--bail'], x)).toBe(1);
    expect(x.out).toContain('Expected Status to equal');
    expect(await main(['run', 'collection', 'missing'], x)).toBe(2);
    expect(x.err).toContain('Collection "missing" not found');
  });

  it('runs a single request with --var overrides and data files', async () => {
    await seed();
    await writeFile(join(dir, 'rows.csv'), 'password\nsecret\nwrong\n');
    const x = io();
    expect(await main(['run', 'request', 'Login', '--data', 'rows.csv'], x)).toBe(1);
    expect(x.out).toContain('Iteration 2/2');
    const y = io();
    expect(await main(['run', 'request', 'login', '--var', 'password=secret'], y)).toBe(0);
  });

  it('validates the workspace', async () => {
    const { collection } = await seed();
    const x = io();
    expect(await main(['validate'], x)).toBe(0);
    expect(x.out).toContain('0 errors');
    const store = new FileSystemStore(join(dir, '.reqvyn'));
    await store.saveRequest(collection.id, createRequest({ name: 'Broken', url: '{{base}}/{{nowhere}}', scripts: { pre: 'if (', post: '' } }));
    store.dispose();
    const y = io();
    expect(await main(['validate', '--json'], y)).toBe(1);
    const report = JSON.parse(y.out);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'error', message: expect.stringMatching(/Syntax error/) }),
        expect.objectContaining({ level: 'warning', message: 'Variable {{nowhere}} is not defined in any scope.' }),
      ]),
    );
  });

  it('imports files into a new workspace and exports them again', async () => {
    await writeFile(join(dir, 'req.sh'), `curl -X POST ${srv.url}/echo -H 'X-A: 1' -d '{"a":1}'`);
    const x = io();
    expect(await main(['import', 'req.sh'], x)).toBe(0);
    expect(x.out).toContain('imported collection');
    expect(existsSync(join(dir, '.reqvyn', 'collections'))).toBe(true);
    const l = io();
    expect(await main(['list', '--json'], l)).toBe(0);
    const listed = JSON.parse(l.out);
    expect(listed.collections).toHaveLength(1);
    const again = io();
    await main(['import', 'req.sh', '--dry-run'], again);
    expect(again.out).toContain('would import');
    const e = io();
    expect(await main(['export', listed.collections[0].id, '--format', 'postman'], e)).toBe(0);
    expect(JSON.parse(e.out).info.schema).toContain('getpostman');
    expect(await main(['export', listed.collections[0].id, '--format', 'package', '--out', 'c.reqvyn'], io())).toBe(0);
    expect(readFileSync(join(dir, 'c.reqvyn')).subarray(0, 2).toString()).toBe('PK');
  });

  it('parses arguments strictly', () => {
    expect(() => parseArgs(['--bogus'], RUN_OPTIONS)).toThrow(/Unknown option/);
    expect(parseArgs(['x', '--report=json,junit', '-r', 'html', '--no-scripts'], RUN_OPTIONS).options).toMatchObject({ report: ['json', 'junit', 'html'], 'no-scripts': true });
  });
});

describe('EnvSecretVault', () => {
  it('maps vault keys to REQVYN_SECRET_* names', async () => {
    const v = new EnvSecretVault({ REQVYN_SECRET_API_KEY: 'a', REQVYN_SECRET_PROD_TOKEN: 'p', REQVYN_SECRET_TOKEN: 't' }, { 'named.file': 'f' }, new Map([['e1', 'prod']]));
    expect(await v.get('env.e1.token')).toBe('p');
    expect(await v.get('env.e2.token')).toBe('t');
    expect(await v.get('named.api-key')).toBe('a');
    expect(await v.get('named.file')).toBe('f');
    await v.set('oauth2.x', 'y');
    expect(await v.get('oauth2.x')).toBe('y');
    await v.delete('named.api-key');
    expect(await v.get('named.api-key')).toBeUndefined();
  });
});

describe('MCP server', () => {
  it('is disabled by default', async () => {
    await seed();
    const x = io();
    expect(await main(['mcp'], x, { input: new PassThrough(), output: () => undefined })).toBe(2);
    expect(x.err).toContain('disabled by default');
  });

  it('serves tools over stdio with a read-only default policy', async () => {
    const { collection } = await seed();
    const store = new FileSystemStore(join(dir, '.reqvyn'));
    const server = new McpServer({ store, policy: { allowWrite: false, allowNetwork: false, allowedHosts: [] } });
    const call = async (name: string, args: Record<string, unknown> = {}) => (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as { result: { isError: boolean; content: Array<{ text: string }>; structuredContent?: any } };
    const init = await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(init).toMatchObject({ result: { serverInfo: { name: 'reqvyn' } } });
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    const tools = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as { result: { tools: Array<{ name: string }> } };
    expect(tools.result.tools.map((t) => t.name)).toContain('run_tests');

    const listed = await call('list_collections');
    expect(listed.result.structuredContent.collections[0].name).toBe('Users API');
    const tree = await call('get_collection', { collectionId: collection.id });
    expect(JSON.stringify(tree.result.structuredContent.tree)).toContain('Login');
    expect((await call('create_request', { collectionId: collection.id, request: { name: 'x' } })).result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('--allow-write') }] });
    expect((await call('run_tests', { collectionId: collection.id })).result.content[0]!.text).toContain('--allow-network');
    store.dispose();
  });

  it('creates requests and runs tests when the policy allows it, honouring the host allow-list', async () => {
    const { collection, env } = await seed();
    const store = new FileSystemStore(join(dir, '.reqvyn'));
    const vault = new EnvSecretVault({ REQVYN_SECRET_PASSWORD: 'secret' });
    const server = new McpServer({ store, policy: { allowWrite: true, allowNetwork: true, allowedHosts: ['127.0.0.1'] }, vault, exec: { scripts: { enabled: false } } });
    const call = async (name: string, args: Record<string, unknown>) => ((await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as any).result;
    const created = await call('create_request', { collectionId: collection.id, request: { name: 'Echo', method: 'PUT', url: '{{base}}/echo' } });
    expect(created.isError).toBe(false);
    const run = await call('run_tests', { collectionId: collection.id, environmentId: env.id });
    expect(run.isError).toBe(false);
    expect(run.structuredContent.summary.passed).toBe(3);
    expect(JSON.stringify(run.structuredContent)).not.toContain('tok-123');
    const again = await call('get_test_results', { runId: run.structuredContent.runId });
    expect(again.structuredContent.results).toHaveLength(3);

    const blocked = new McpServer({ store, policy: { allowWrite: false, allowNetwork: true, allowedHosts: ['api.example.com'] }, vault });
    const res = ((await blocked.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_tests', arguments: { collectionId: collection.id } } })) as any).result;
    expect(res.structuredContent.results[0].error.code).toBe('UNTRUSTED');

    // A redirect from an allowed host to a host outside the allow-list is blocked as well.
    const outside = `${srv.url.replace('127.0.0.1', 'localhost')}/echo`;
    await store.saveRequest(collection.id, createRequest({ name: 'Hop', url: `${srv.url}/redirect-to?url=${encodeURIComponent(outside)}` }));
    const hop = await call('run_tests', { collectionId: collection.id, environmentId: env.id });
    const hopResult = (hop.structuredContent.results as Array<{ request: string; error?: { code: string } }>).find((r) => r.request === 'Hop');
    expect(hopResult?.error?.code).toBe('UNTRUSTED');
    store.dispose();
  });

  it('answers JSON-RPC over a stream', async () => {
    await seed();
    await mkdir(join(dir, 'sub'));
    const input = new PassThrough();
    const lines: string[] = [];
    const x = io();
    const done = main(['mcp', '--enable'], x, { input, output: (l) => lines.push(l) });
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\nnot json\n');
    await new Promise((r) => setTimeout(r, 200));
    input.end();
    expect(await done).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l))).toEqual(expect.arrayContaining([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    ]));
  });
});
