/**
 * End-to-end: two REQVYN installations (separate local stores + separate persistent sync state)
 * sharing one Local Folder remote, exercising the full engine → registry-free provider path.
 */
import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCollection, createFolder, createRequest, type Collection } from '../packages/core/src/index.js';
import {
  FileSyncStateStore,
  FlakySyncProvider,
  MemoryLocalCollections,
  SyncEngine,
  createTestProviderContext,
} from '../packages/sync-core/src/index.js';
import { LocalFolderSyncProvider } from '../packages/providers/local/src/index.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'reqvyn-two-installs-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
let remoteDir = '';

interface Installation {
  name: string;
  local: MemoryLocalCollections;
  provider: FlakySyncProvider;
  engine: SyncEngine;
  edit(fn: (c: Collection) => void): Promise<void>;
  get(): Collection;
}

async function installation(name: string): Promise<Installation> {
  const inner = new LocalFolderSyncProvider();
  await inner.initialize(createTestProviderContext({ folderPath: remoteDir }, { instanceId: 'shared-folder' }));
  const provider = new FlakySyncProvider(inner);
  const local = new MemoryLocalCollections();
  const engine = new SyncEngine({
    provider,
    instanceId: 'shared-folder',
    local,
    stateStore: new FileSyncStateStore(path.join(tmp, `case-${n}`, `${name}-state`)),
    retry: { retries: 3, baseDelayMs: 1, maxDelayMs: 5 },
  });
  return {
    name,
    local,
    provider,
    engine,
    async edit(fn) {
      const c = (await local.load('api'))!;
      fn(c);
      await local.save(c);
    },
    get: () => local.collections.get('api')!,
  };
}

function sample(): Collection {
  const c = createCollection({ id: 'api', name: 'Team API' });
  c.folders.push(createFolder({ id: 'users', name: 'Users', sortKey: 1 }));
  c.requests.push(createRequest({ id: 'list', name: 'List users', url: 'https://api.test/users', parentId: 'users', sortKey: 1 }));
  c.requests.push(createRequest({ id: 'get', name: 'Get user', url: 'https://api.test/users/1', parentId: 'users', sortKey: 2 }));
  c.requests.push(createRequest({ id: 'health', name: 'Health', url: 'https://api.test/health', sortKey: 3 }));
  return c;
}

const req = (c: Collection, id: string) => c.requests.find((r) => r.id === id);

/** Two installations that already share the sample collection. */
async function pair() {
  const a = await installation('A');
  const b = await installation('B');
  await a.local.save(sample());
  expect((await a.engine.sync('api')).status).toBe('synced');
  expect((await b.engine.sync('api')).status).toBe('synced');
  return { a, b };
}

beforeEach(async () => {
  n++;
  remoteDir = path.join(tmp, `case-${n}`, 'shared-remote');
  await fs.mkdir(remoteDir, { recursive: true });
});

describe('two installations sharing a Local Folder remote', () => {
  it('initial push from A, pull on B', async () => {
    const a = await installation('A');
    const b = await installation('B');
    await a.local.save(sample());
    const pushed = await a.engine.sync('api');
    expect(pushed).toMatchObject({ status: 'synced', pushed: true });
    expect(pushed.remoteChanges.added.sort()).toEqual(['api', 'get', 'health', 'list', 'users']);
    // Remote layout is human-readable files.
    expect((await fs.readdir(remoteDir)).filter((x) => !x.startsWith('.'))).toEqual(['api']);

    const pulled = await b.engine.sync('api');
    expect(pulled).toMatchObject({ status: 'synced', appliedLocally: true, pushed: false });
    expect(b.get().name).toBe('Team API');
    expect(b.get().requests.map((r) => r.id).sort()).toEqual(['get', 'health', 'list']);
    expect(req(b.get(), 'list')?.parentId).toBe('users');
    expect((await a.engine.sync('api')).status).toBe('up-to-date');
    expect((await b.engine.sync('api')).status).toBe('up-to-date');
  });

  it('offline edits are kept locally and pushed when back online', async () => {
    const { a, b } = await pair();
    a.provider.offline = true;
    await a.edit((c) => {
      req(c, 'health')!.name = 'Health (offline edit)';
      c.requests.push(createRequest({ id: 'new', name: 'Created offline', sortKey: 4 }));
    });
    const offline = await a.engine.sync('api');
    expect(offline.status).toBe('failed');
    expect(offline.error).toMatchObject({ code: 'NETWORK', retryable: true });
    expect(req(a.get(), 'health')?.name).toBe('Health (offline edit)'); // nothing lost locally
    expect((await a.engine.getState('api')).lastError?.code).toBe('NETWORK');

    a.provider.offline = false;
    expect((await a.engine.sync('api')).status).toBe('synced');
    expect((await a.engine.getState('api')).lastError).toBeFalsy();
    await b.engine.sync('api');
    expect(req(b.get(), 'health')?.name).toBe('Health (offline edit)');
    expect(req(b.get(), 'new')?.name).toBe('Created offline');
  });

  it('merges non-conflicting concurrent edits from both sides', async () => {
    const { a, b } = await pair();
    await a.edit((c) => {
      req(c, 'list')!.name = 'List all users';
      c.requests = c.requests.filter((r) => r.id !== 'health');
    });
    await b.edit((c) => {
      req(c, 'list')!.url = 'https://api.test/v2/users'; // same entity, different field
      req(c, 'get')!.method = 'POST';
      c.requests.push(createRequest({ id: 'b-new', name: 'From B', sortKey: 9 }));
    });
    expect((await a.engine.sync('api')).status).toBe('synced');
    const rb = await b.engine.sync('api');
    expect(rb.status).toBe('synced');
    expect(rb.conflicts).toEqual([]);
    expect(rb.autoMerged).toContain('list');
    await a.engine.sync('api');
    for (const inst of [a, b]) {
      const c = inst.get();
      expect(req(c, 'list')).toMatchObject({ name: 'List all users', url: 'https://api.test/v2/users' });
      expect(req(c, 'get')?.method).toBe('POST');
      expect(req(c, 'health')).toBeUndefined();
      expect(req(c, 'b-new')?.name).toBe('From B');
    }
    expect((await a.engine.sync('api')).status).toBe('up-to-date');
    expect((await b.engine.sync('api')).status).toBe('up-to-date');
  });

  async function conflicted() {
    const { a, b } = await pair();
    await a.edit((c) => void (req(c, 'get')!.name = 'A title'));
    await b.edit((c) => void (req(c, 'get')!.name = 'B title'));
    expect((await a.engine.sync('api')).status).toBe('synced');
    const rb = await b.engine.sync('api');
    expect(rb.status).toBe('conflicts');
    expect(rb.conflicts).toHaveLength(1);
    expect(rb.conflicts[0]).toMatchObject({ id: 'get', type: 'edit-edit', fields: ['name'] });
    expect(req(b.get(), 'get')?.name).toBe('B title'); // unresolved: local stays
    return { a, b, conflict: rb.conflicts[0]! };
  }

  it('conflicting edits resolved with keep-local', async () => {
    const { a, b } = await conflicted();
    const r = await b.engine.resolveConflicts('api', { get: 'local' });
    expect(r).toMatchObject({ status: 'synced', resolved: ['get'], pushed: true });
    await a.engine.sync('api');
    expect(req(a.get(), 'get')?.name).toBe('B title');
    expect(await b.engine.getPendingConflicts('api')).toEqual([]);
  });

  it('conflicting edits resolved with keep-remote', async () => {
    const { a, b } = await conflicted();
    const r = await b.engine.resolveConflicts('api', { get: 'remote' });
    expect(r).toMatchObject({ status: 'synced', resolved: ['get'] });
    expect(req(b.get(), 'get')?.name).toBe('A title');
    expect((await a.engine.sync('api')).status).toBe('up-to-date');
  });

  it('conflicting edits resolved with a merged value', async () => {
    const { a, b, conflict } = await conflicted();
    const mergedData = { ...(conflict.local!.data as Record<string, unknown>), name: 'A + B title' };
    const r = await b.engine.resolveConflicts('api', { get: { choice: 'merged', mergedData: mergedData as never } });
    expect(r).toMatchObject({ status: 'synced', resolved: ['get'] });
    expect(req(b.get(), 'get')?.name).toBe('A + B title');
    await a.engine.sync('api');
    expect(req(a.get(), 'get')?.name).toBe('A + B title');
  });

  it('conflicting deletion (deleted on A, edited on B) can be resolved either way', async () => {
    const { a, b } = await pair();
    await a.edit((c) => void (c.requests = c.requests.filter((r) => r.id !== 'health')));
    await b.edit((c) => void (req(c, 'health')!.url = 'https://api.test/healthz'));
    expect((await a.engine.sync('api')).status).toBe('synced');
    const rb = await b.engine.sync('api');
    expect(rb.status).toBe('conflicts');
    expect(rb.conflicts[0]).toMatchObject({ id: 'health', type: 'edit-delete', remote: null });
    expect(req(b.get(), 'health')?.url).toBe('https://api.test/healthz');

    // Keep B's edit: the request is resurrected for everyone.
    expect((await b.engine.resolveConflicts('api', { health: 'local' })).status).toBe('synced');
    await a.engine.sync('api');
    expect(req(a.get(), 'health')?.url).toBe('https://api.test/healthz');

    // And the reverse: B deletes, A edits; A accepts the deletion.
    await b.edit((c) => void (c.requests = c.requests.filter((r) => r.id !== 'health')));
    await a.edit((c) => void (req(c, 'health')!.name = 'edited on A'));
    expect((await b.engine.sync('api')).status).toBe('synced');
    const ra = await a.engine.sync('api');
    expect(ra.conflicts[0]).toMatchObject({ id: 'health', type: 'edit-delete' });
    expect((await a.engine.resolveConflicts('api', { health: 'remote' })).status).toBe('synced');
    expect(req(a.get(), 'health')).toBeUndefined();
    expect((await b.engine.sync('api')).status).toBe('up-to-date');
  });

  it('survives an outage mid-sync and retries', async () => {
    const { a, b } = await pair();
    await a.edit((c) => void (req(c, 'list')!.name = 'after outage'));
    // Transient failures inside one run are retried by the engine…
    a.provider.failNext(2, 'UNAVAILABLE', ['push']);
    const r = await a.engine.sync('api');
    expect(r.status).toBe('synced');
    expect(r.attempts).toBe(3);
    // …a longer outage fails the run without losing anything; the next run catches up.
    await b.edit((c) => void (req(c, 'get')!.name = 'B during outage'));
    b.provider.offline = true;
    expect((await b.engine.sync('api')).status).toBe('failed');
    expect(req(b.get(), 'list')?.name).toBe('List users');
    expect(req(b.get(), 'get')?.name).toBe('B during outage');
    // Lost response: the write lands but B never hears back; the retry settles without conflicts.
    b.provider.offline = false;
    b.provider.loseNextPushResponses(1);
    const rb = await b.engine.sync('api');
    expect(rb.conflicts).toEqual([]);
    expect(['synced', 'up-to-date']).toContain(rb.status);
    expect(req(b.get(), 'list')?.name).toBe('after outage');
    await a.engine.sync('api');
    expect(req(a.get(), 'get')?.name).toBe('B during outage');
  });

  it('serializes concurrent syncs from both installations on the shared folder', async () => {
    const { a, b } = await pair();
    await a.edit((c) => void (req(c, 'list')!.name = 'A concurrent'));
    await b.edit((c) => void (req(c, 'get')!.name = 'B concurrent'));
    const [ra, rb] = await Promise.all([a.engine.sync('api'), b.engine.sync('api')]);
    expect([ra.status, rb.status].every((s) => s === 'synced' || s === 'up-to-date')).toBe(true);
    await a.engine.sync('api');
    await b.engine.sync('api');
    for (const inst of [a, b]) {
      expect(req(inst.get(), 'list')?.name).toBe('A concurrent');
      expect(req(inst.get(), 'get')?.name).toBe('B concurrent');
    }
  });
});
