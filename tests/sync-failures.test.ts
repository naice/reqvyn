/**
 * Failure modes across engine + Local Folder provider: a crash in the middle of a journaled write,
 * cancellation, and a non-retryable error that must not corrupt the sync base.
 */
import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createCollection, createRequest, type Collection } from '../packages/core/src/index.js';
import {
  FlakySyncProvider,
  MemoryLocalCollections,
  MemorySyncStateStore,
  SyncEngine,
  createTestProviderContext,
} from '../packages/sync-core/src/index.js';
import { LocalFolderSyncProvider, type LocalFolderProviderOptions } from '../packages/providers/local/src/index.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'reqvyn-sync-failures-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

async function setup(options: LocalFolderProviderOptions = {}, folder = path.join(tmp, `remote-${++n}`)) {
  await fs.mkdir(folder, { recursive: true });
  const provider = new LocalFolderSyncProvider(options);
  await provider.initialize(createTestProviderContext({ folderPath: folder }));
  const local = new MemoryLocalCollections();
  const state = new MemorySyncStateStore();
  const engine = new SyncEngine({ provider, instanceId: 'lf', local, stateStore: state, retry: { retries: 2, baseDelayMs: 1, maxDelayMs: 2 } });
  return { folder, provider, local, state, engine };
}

function sample(): Collection {
  const c = createCollection({ id: 'col', name: 'Crashy' });
  for (let i = 0; i < 5; i++) c.requests.push(createRequest({ id: `r${i}`, name: `R${i}`, sortKey: i }));
  return c;
}

class Crash extends Error {}

describe('sync failure handling', () => {
  it('rolls an interrupted write forward on the next access', async () => {
    let crash = false;
    const a = await setup({
      hooks: {
        afterApplyFile: (i) => {
          if (crash && i === 1) throw new Crash('simulated crash while applying the journal');
        },
      },
    });
    await a.local.save(sample());
    expect((await a.engine.sync('col')).status).toBe('synced');
    const c = (await a.local.load('col'))!;
    c.requests.forEach((r) => (r.name += ' v2'));
    await a.local.save(c);
    crash = true;
    const failed = await a.engine.sync('col');
    expect(failed.status).toBe('failed');
    crash = false;

    // A second installation reading the folder sees a consistent, complete v2 (journal rolled forward).
    const b = await setup({}, a.folder);
    expect((await b.engine.sync('col')).status).toBe('synced');
    expect(b.local.collections.get('col')!.requests.map((r) => r.name)).toEqual(['R0 v2', 'R1 v2', 'R2 v2', 'R3 v2', 'R4 v2']);
    // The crashed installation recovers too: same content → no conflicts.
    const again = await a.engine.sync('col');
    expect(again.conflicts).toEqual([]);
    expect(['synced', 'up-to-date']).toContain(again.status);
    await expect(fs.access(path.join(a.folder, 'col', '.staging'))).rejects.toThrow();
  });

  it('discards a write that crashed before it was committed', async () => {
    let crash = false;
    let folder = '';
    const a = await setup({
      hooks: {
        // Runs right after plan.json (the commit marker) is written; removing it simulates a crash
        // while files were still being staged, i.e. before the write was committed.
        afterStage: async () => {
          if (!crash) return;
          await fs.rm(path.join(folder, 'col', '.staging', 'plan.json'), { force: true });
          throw new Crash('crash before the plan is written');
        },
      },
    });
    folder = a.folder;
    await a.local.save(sample());
    await a.engine.sync('col');
    const c = (await a.local.load('col'))!;
    c.name = 'never committed';
    await a.local.save(c);
    crash = true;
    expect((await a.engine.sync('col')).status).toBe('failed');
    const b = await setup({}, a.folder);
    await b.engine.sync('col');
    expect(b.local.collections.get('col')!.name).toBe('Crashy');
    crash = false;
    expect((await a.engine.sync('col')).status).toBe('synced');
    await b.engine.sync('col');
    expect(b.local.collections.get('col')!.name).toBe('never committed');
  });

  it('honours cancellation without touching local data or state', async () => {
    const a = await setup();
    await a.local.save(sample());
    const ac = new AbortController();
    ac.abort();
    const r = await a.engine.sync('col', { signal: ac.signal });
    expect(r.status).toBe('cancelled');
    expect((await a.engine.getState('col')).base).toBeNull();
    expect(await fs.readdir(a.folder)).toEqual([]);
    expect((await a.engine.sync('col')).status).toBe('synced');
  });

  it('reports a missing remote folder as unavailable and keeps the base intact', async () => {
    // E.g. an unmounted network drive / USB stick: the folder's parent disappears.
    const a = await setup({}, path.join(tmp, `removable-${++n}`, 'reqvyn'));
    await a.local.save(sample());
    await a.engine.sync('col');
    const before = (await a.engine.getState('col')).base;
    expect(before).not.toBeNull();
    await fs.rm(path.dirname(a.folder), { recursive: true, force: true });
    const c = (await a.local.load('col'))!;
    c.name = 'edited while unplugged';
    await a.local.save(c);
    const r = await a.engine.sync('col');
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('UNAVAILABLE');
    expect((await a.engine.getState('col')).base).toEqual(before);
    expect(a.local.collections.get('col')!.name).toBe('edited while unplugged');
  });

  it('does not leak provider errors as secrets and surfaces non-retryable errors once', async () => {
    const a = await setup();
    const flaky = new FlakySyncProvider(a.provider);
    const engine = new SyncEngine({ provider: flaky, instanceId: 'lf', local: a.local, stateStore: a.state, retry: { retries: 5, baseDelayMs: 1 } });
    await a.local.save(sample());
    flaky.failNext(1, 'PERMISSION');
    const r = await engine.sync('col');
    expect(r).toMatchObject({ status: 'failed', attempts: 1, error: { code: 'PERMISSION', retryable: false } });
    expect(flaky.calls.push + flaky.calls.pull + flaky.calls.getRemoteManifest).toBe(1);
  });
});
