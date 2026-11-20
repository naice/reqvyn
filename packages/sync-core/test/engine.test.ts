import { describe, expect, it } from 'vitest';
import { createCollection, createRequest, type Collection } from '@reqvyn/core';
import {
  FlakySyncProvider,
  MemoryLocalCollections,
  MemoryRemoteStore,
  MemorySyncProvider,
  MemorySyncStateStore,
  SyncEngine,
} from '../src/index.js';
import type { SyncProgress, SyncProvider } from '@reqvyn/provider-sdk';

function install(provider: SyncProvider, extra: { onProgress?: (p: SyncProgress) => void } = {}) {
  const local = new MemoryLocalCollections();
  const state = new MemorySyncStateStore();
  const engine = new SyncEngine({ provider, instanceId: 'i1', local, stateStore: state, retry: { retries: 3, baseDelayMs: 1, maxDelayMs: 5 }, ...extra });
  return { local, state, engine };
}

function sample(): Collection {
  const c = createCollection({ id: 'col', name: 'API' });
  c.requests.push(createRequest({ id: 'r1', name: 'List', url: 'https://x.test/a', sortKey: 1 }));
  c.requests.push(createRequest({ id: 'r2', name: 'Get', url: 'https://x.test/b', sortKey: 2 }));
  return c;
}

const req = (c: Collection | undefined, id: string) => c?.requests.find((r) => r.id === id);

describe('SyncEngine', () => {
  it('pushes a new collection, pulls it elsewhere and reports up-to-date', async () => {
    const remote = new MemoryRemoteStore();
    const a = install(new MemorySyncProvider(remote));
    const b = install(new MemorySyncProvider(remote));
    await a.local.save(sample());
    const r1 = await a.engine.sync('col');
    expect(r1).toMatchObject({ status: 'synced', pushed: true });
    expect(r1.remoteChanges.added.sort()).toEqual(['col', 'r1', 'r2']);
    const r2 = await b.engine.sync('col');
    expect(r2).toMatchObject({ status: 'synced', appliedLocally: true, pushed: false });
    expect(req(b.local.collections.get('col'), 'r1')?.name).toBe('List');
    expect((await a.engine.sync('col')).status).toBe('up-to-date');
    expect((await b.engine.getState('col')).lastRevision).toBe(r1.revision);
  });

  it('merges concurrent edits and surfaces conflicts until resolved', async () => {
    const remote = new MemoryRemoteStore();
    const a = install(new MemorySyncProvider(remote));
    const b = install(new MemorySyncProvider(remote));
    await a.local.save(sample());
    await a.engine.sync('col');
    await b.engine.sync('col');

    const ca = (await a.local.load('col'))!;
    req(ca, 'r1')!.name = 'A name';
    req(ca, 'r2')!.url = 'https://x.test/a-url';
    await a.local.save(ca);
    const cb = (await b.local.load('col'))!;
    req(cb, 'r1')!.name = 'B name';
    req(cb, 'r2')!.method = 'POST';
    await b.local.save(cb);

    expect((await a.engine.sync('col')).status).toBe('synced');
    const rb = await b.engine.sync('col');
    expect(rb.status).toBe('conflicts');
    expect(rb.conflicts.map((c) => [c.id, c.type])).toEqual([['r1', 'edit-edit']]);
    expect(rb.autoMerged).toContain('r2');
    const merged = (await b.local.load('col'))!;
    expect(req(merged, 'r2')).toMatchObject({ url: 'https://x.test/a-url', method: 'POST' });
    expect(req(merged, 'r1')?.name).toBe('B name'); // local kept while unresolved
    expect((await b.engine.getPendingConflicts('col')).map((c) => c.id)).toEqual(['r1']);
    // A sync without decisions keeps reporting the conflict.
    expect((await b.engine.sync('col')).status).toBe('conflicts');

    const res = await b.engine.resolveConflicts('col', { r1: 'remote' });
    expect(res).toMatchObject({ status: 'synced', resolved: ['r1'] });
    expect(req(b.local.collections.get('col'), 'r1')?.name).toBe('A name');
    expect(await b.engine.getPendingConflicts('col')).toEqual([]);
    await a.engine.sync('col');
    expect(req(a.local.collections.get('col'), 'r2')).toMatchObject({ method: 'POST' });
  });

  it('ignores stale decisions', async () => {
    const remote = new MemoryRemoteStore();
    const a = install(new MemorySyncProvider(remote));
    const b = install(new MemorySyncProvider(remote));
    await a.local.save(sample());
    await a.engine.sync('col');
    await b.engine.sync('col');
    const ca = (await a.local.load('col'))!;
    req(ca, 'r1')!.name = 'A1';
    await a.local.save(ca);
    await a.engine.sync('col');
    const cb = (await b.local.load('col'))!;
    req(cb, 'r1')!.name = 'B1';
    await b.local.save(cb);
    expect((await b.engine.sync('col')).status).toBe('conflicts');
    // Remote changes again before the user decides → the decision no longer applies.
    const ca2 = (await a.local.load('col'))!;
    req(ca2, 'r1')!.name = 'A2';
    await a.local.save(ca2);
    await a.engine.sync('col');
    const r = await b.engine.resolveConflicts('col', { r1: 'local' });
    expect(r.staleDecisions).toEqual(['r1']);
    expect(r.status).toBe('conflicts');
  });

  it('retries transient failures and reports progress', async () => {
    const flaky = new FlakySyncProvider(new MemorySyncProvider());
    const phases: string[] = [];
    const a = install(flaky, { onProgress: (p) => phases.push(p.phase) });
    await a.local.save(sample());
    flaky.failNext(2, 'NETWORK', ['pull']);
    const r = await a.engine.sync('col');
    expect(r.status).toBe('synced');
    expect(r.attempts).toBe(3);
    expect(phases).toContain('retry');
    expect(phases).toContain('push');
    expect(phases.at(-1)).toBe('done');
  });

  it('does not retry non-retryable failures and keeps the base', async () => {
    const flaky = new FlakySyncProvider(new MemorySyncProvider());
    const a = install(flaky);
    await a.local.save(sample());
    flaky.failNext(1, 'AUTH');
    const r = await a.engine.sync('col');
    expect(r).toMatchObject({ status: 'failed', attempts: 1, error: { code: 'AUTH', retryable: false } });
    const st = await a.engine.getState('col');
    expect(st.base).toBeNull();
    expect(st.lastError?.code).toBe('AUTH');
    expect((await a.engine.sync('col')).status).toBe('synced');
  });

  it('handles a lost push response without duplicating or conflicting', async () => {
    const remote = new MemoryRemoteStore();
    const flaky = new FlakySyncProvider(new MemorySyncProvider(remote));
    const a = install(flaky);
    await a.local.save(sample());
    flaky.loseNextPushResponses(1);
    const r = await a.engine.sync('col');
    // The write landed on the first attempt; the retry re-pulls, finds identical content and settles.
    expect(r.status).toBe('up-to-date');
    expect(r.attempts).toBe(2);
    expect(r.conflicts).toEqual([]);
    expect(remote.pushes).toBe(1);
    expect((await a.engine.getState('col')).lastRevision).toBe(remote.collections.get('col')!.revision);
    expect((await a.engine.sync('col')).status).toBe('up-to-date');
  });

  it('re-pulls and merges when another writer pushes in between (optimistic concurrency)', async () => {
    const remote = new MemoryRemoteStore();
    const a = install(new MemorySyncProvider(remote));
    const flaky = new FlakySyncProvider(new MemorySyncProvider(remote));
    const b = install(flaky);
    await a.local.save(sample());
    await a.engine.sync('col');
    await b.engine.sync('col');
    const cb = (await b.local.load('col'))!;
    req(cb, 'r2')!.name = 'B edit';
    await b.local.save(cb);
    flaky.beforePush = async () => {
      const ca = (await a.local.load('col'))!;
      req(ca, 'r1')!.name = 'A sneaks in';
      await a.local.save(ca);
      expect((await a.engine.sync('col')).status).toBe('synced');
    };
    const r = await b.engine.sync('col');
    expect(r.status).toBe('synced');
    expect(r.attempts).toBe(2);
    const final = b.local.collections.get('col')!;
    expect(req(final, 'r1')?.name).toBe('A sneaks in');
    expect(req(final, 'r2')?.name).toBe('B edit');
  });

  it('works with providers without optimistic concurrency (manifest pre-check)', async () => {
    const remote = new MemoryRemoteStore();
    const a = install(new MemorySyncProvider(remote, { optimisticConcurrency: false }));
    await a.local.save(sample());
    expect((await a.engine.sync('col')).status).toBe('synced');
    expect((await a.engine.sync('col')).status).toBe('up-to-date');
  });

  it('supports pull-only and push-only modes', async () => {
    const remote = new MemoryRemoteStore();
    const a = install(new MemorySyncProvider(remote));
    const b = install(new MemorySyncProvider(remote));
    await a.local.save(sample());
    expect((await a.engine.pull('col')).pushed).toBe(false);
    expect(remote.collections.size).toBe(0);
    expect((await a.engine.push('col')).pushed).toBe(true);
    await b.engine.pull('col');
    const ca = (await a.local.load('col'))!;
    req(ca, 'r1')!.name = 'changed by A';
    await a.local.save(ca);
    await a.engine.push('col');
    const cb = (await b.local.load('col'))!;
    req(cb, 'r2')!.name = 'changed by B';
    await b.local.save(cb);
    expect((await b.engine.push('col')).status).toBe('remote-ahead');
    expect(req(b.local.collections.get('col'), 'r1')?.name).not.toBe('changed by A');
    expect((await b.engine.sync('col')).status).toBe('synced');
  });

  it('can be cancelled', async () => {
    const a = install(new FlakySyncProvider(new MemorySyncProvider()));
    await a.local.save(sample());
    const ac = new AbortController();
    ac.abort();
    const r = await a.engine.sync('col', { signal: ac.signal });
    expect(r.status).toBe('cancelled');
    expect((await a.engine.getState('col')).base).toBeNull();
  });

  it('serializes concurrent runs for the same collection', async () => {
    const remote = new MemoryRemoteStore();
    const a = install(new MemorySyncProvider(remote));
    await a.local.save(sample());
    const results = await Promise.all([a.engine.sync('col'), a.engine.sync('col'), a.engine.sync('col')]);
    expect(results.map((r) => r.status)).toEqual(['synced', 'up-to-date', 'up-to-date']);
    expect(remote.pushes).toBe(1);
  });
});
