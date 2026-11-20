import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEntity, emptySnapshot, validateDescriptor, type SyncProviderContext } from '@reqvyn/provider-sdk';
import { RestSyncProvider, restDescriptor, statusToCode } from '../src/provider.js';
import { createReferenceServer, type ReferenceServer } from '../src/server.js';
// The example only depends on the SDK; the engine is pulled in relatively to show an end-to-end flow.
import {
  MemoryLocalCollections,
  MemorySyncStateStore,
  SyncEngine,
  createTestProviderContext,
} from '../../../packages/sync-core/src/index.js';
import { createCollection, createRequest } from '../../../packages/core/src/index.js';

const TOKEN = 'tok-' + 'x'.repeat(24);
let srv: ReferenceServer;
let baseUrl = '';

beforeAll(async () => {
  srv = createReferenceServer({ token: TOKEN });
  baseUrl = await srv.listen();
});
afterAll(() => srv.close());

async function provider(token = TOKEN, extra: Record<string, string | number | boolean> = {}): Promise<RestSyncProvider> {
  const p = new RestSyncProvider({ retryBaseDelayMs: 1 });
  await p.initialize(createTestProviderContext({ baseUrl, retries: 3, ...extra }, { secrets: token ? { token } : {} }) as SyncProviderContext);
  return p;
}

function snap(id: string, name: string) {
  const s = emptySnapshot(id);
  s.entities[id] = createEntity('collection', { id, name });
  return s;
}

describe('RestSyncProvider', () => {
  it('has a valid descriptor and maps statuses', () => {
    expect(validateDescriptor(restDescriptor)).toEqual([]);
    expect([401, 403, 404, 409, 412, 429, 503].map(statusToCode)).toEqual(['AUTH', 'PERMISSION', 'NOT_FOUND', 'CONFLICT', 'CONFLICT', 'RATE_LIMIT', 'UNAVAILABLE']);
  });

  it('refuses insecure configurations', async () => {
    const p = new RestSyncProvider();
    await expect(p.initialize(createTestProviderContext({ baseUrl: 'http://sync.example.com/' }))).rejects.toMatchObject({ code: 'CONFIG' });
    await expect(p.initialize(createTestProviderContext({ baseUrl: 'https://u:p@sync.example.com/' }))).rejects.toMatchObject({ code: 'CONFIG' });
  });

  it('round-trips with If-Match / If-None-Match concurrency', async () => {
    const p = await provider();
    expect((await p.testConnection()).ok).toBe(true);
    expect(await p.pull('c1')).toBeNull();
    const r1 = await p.push('c1', snap('c1', 'one'), null);
    expect(r1.status).toBe('ok');
    const rev = r1.status === 'ok' ? r1.revision : '';
    expect((await p.pull('c1'))?.revision).toBe(rev);
    expect((await p.getRemoteManifest('c1'))?.revision).toBe(rev);
    expect(await p.push('c1', snap('c1', 'again'), null)).toMatchObject({ status: 'conflict', remoteRevision: rev });
    expect(await p.push('c1', snap('c1', 'stale'), 'not-the-rev')).toMatchObject({ status: 'conflict', remoteRevision: rev });
    expect((await p.push('c1', snap('c1', 'two'), rev)).status).toBe('ok');
    expect((await p.listRemoteCollections()).map((c) => c.collectionId)).toContain('c1');
    await p.deleteRemoteCollection('c1');
    expect(await p.pull('c1')).toBeNull();
  });

  it('maps auth failures and never leaks the token', async () => {
    const p = await provider('wrong-token-SECRET');
    const err = (await p.pull('c1').then(() => new Error('expected failure'), (e: unknown) => e)) as Error & { code: string };
    expect(err).toMatchObject({ code: 'AUTH' });
    expect(String(err.message)).not.toContain('wrong-token-SECRET');
    expect(JSON.stringify(err)).not.toContain('wrong-token-SECRET');
    const health = await p.testConnection();
    expect(health).toMatchObject({ ok: false, code: 'AUTH' });
    const none = await provider('');
    await expect(none.pull('c1')).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('retries 5xx, 429 (Retry-After) and dropped connections', async () => {
    const p = await provider();
    srv.faults.failNext(2, 503);
    expect((await p.push('r', snap('r', 'x'), null)).status).toBe('ok');
    srv.faults.failNext(1, 429, { retryAfter: '0' });
    expect(await p.pull('r')).not.toBeNull();
    srv.faults.dropNext = 1;
    expect(await p.pull('r')).not.toBeNull();
    srv.faults.failNext(10, 503);
    await expect(p.pull('r')).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    srv.faults.take('');
    while (srv.faults.take('')) {
      /* drain */
    }
    srv.faults.failNext(1, 403);
    await expect(p.pull('r')).rejects.toMatchObject({ code: 'PERMISSION', retryable: false });
  });

  it('times out and supports cancellation', async () => {
    const p = await provider(TOKEN, { timeoutMs: 50, retries: 0 });
    srv.faults.delayMs = 300;
    try {
      await expect(p.pull('r')).rejects.toMatchObject({ code: 'NETWORK' });
    } finally {
      srv.faults.delayMs = 0;
    }
    const ac = new AbortController();
    ac.abort();
    await expect((await provider()).pull('r', { signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('works end-to-end with the sync engine (two installations)', async () => {
    const mk = async () => {
      const local = new MemoryLocalCollections();
      const engine = new SyncEngine({ provider: await provider(), instanceId: 'rest', local, stateStore: new MemorySyncStateStore(), retry: { baseDelayMs: 1 } });
      return { local, engine };
    };
    const a = await mk();
    const b = await mk();
    const col = createCollection({ id: 'e2e', name: 'E2E' });
    col.requests.push(createRequest({ id: 'q1', name: 'Q1' }));
    await a.local.save(col);
    expect((await a.engine.sync('e2e')).status).toBe('synced');
    expect((await b.engine.sync('e2e')).status).toBe('synced');
    expect(b.local.collections.get('e2e')?.requests[0]?.name).toBe('Q1');
    const cb = (await b.local.load('e2e'))!;
    cb.requests[0]!.name = 'renamed by B';
    await b.local.save(cb);
    srv.faults.failNext(1, 502);
    expect((await b.engine.sync('e2e')).status).toBe('synced');
    expect((await a.engine.sync('e2e')).status).toBe('synced');
    expect(a.local.collections.get('e2e')?.requests[0]?.name).toBe('renamed by B');
  });
});
