import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createEntity, emptySnapshot, type SyncSnapshot } from '@reqvyn/provider-sdk';
import {
  FileLock,
  FileSystemSyncStore,
  LOCK_FILE,
  STAGING_DIR,
  decodeFileName,
  encodeFileName,
  readCollectionDir,
  recoverCollectionDir,
  writeFileAtomic,
} from '../src/index.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'reqvyn-fs-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => path.join(tmp, `t${n++}`);

function snap(id: string, reqs: Record<string, string>): SyncSnapshot {
  const s = emptySnapshot(id);
  s.entities[id] = createEntity('collection', { id, name: id });
  for (const [rid, name] of Object.entries(reqs)) s.entities[rid] = createEntity('request', { id: rid, name, parentId: null });
  return s;
}

describe('atomic writes and file names', () => {
  it('replaces files atomically and leaves no temp files', async () => {
    const dir = fresh();
    const file = path.join(dir, 'a.json');
    await writeFileAtomic(file, 'one');
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeFileAtomic(file, `v${i}`)));
    expect(await fs.readFile(file, 'utf8')).toMatch(/^v\d+$/);
    expect((await fs.readdir(dir)).filter((x) => x.endsWith('.tmp'))).toEqual([]);
  });

  it('encodes ids reversibly and safely', () => {
    for (const id of ['abc', 'A/B\\..', '..', 'ünï cödé', 'CON', 'x~y', '']) {
      const enc = encodeFileName(id);
      expect(enc).toMatch(/^[a-z0-9_~-]*$/);
      expect(decodeFileName(enc)).toBe(id);
    }
    expect(encodeFileName('A')).not.toBe(encodeFileName('a'));
  });
});

describe('FileLock', () => {
  it('provides mutual exclusion', async () => {
    const lockPath = path.join(fresh(), LOCK_FILE);
    let inside = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        FileLock.with(
          lockPath,
          async () => {
            inside++;
            max = Math.max(max, inside);
            await new Promise((r) => setTimeout(r, 5));
            inside--;
          },
          { retryDelayMs: 5 },
        ),
      ),
    );
    expect(max).toBe(1);
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('times out with a retryable UNAVAILABLE error', async () => {
    const lockPath = path.join(fresh(), LOCK_FILE);
    const held = await FileLock.acquire(lockPath);
    await expect(FileLock.acquire(lockPath, { timeoutMs: 100, retryDelayMs: 10 })).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    await held.release();
    const again = await FileLock.acquire(lockPath, { timeoutMs: 100 });
    await again.release();
  });

  it('breaks stale locks (old heartbeat or dead process)', async () => {
    const dir = fresh();
    await fs.mkdir(dir, { recursive: true });
    const byAge = path.join(dir, 'age.lock');
    await fs.writeFile(byAge, JSON.stringify({ token: 'x', pid: 1, hostname: 'other-host', createdAt: '' }));
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(byAge, old, old);
    const l1 = await FileLock.acquire(byAge, { timeoutMs: 500, staleMs: 60_000 });
    await l1.release();

    const byPid = path.join(dir, 'pid.lock');
    await fs.writeFile(byPid, JSON.stringify({ token: 'y', pid: 2 ** 22 + 12345, hostname: os.hostname(), createdAt: '' }));
    expect(await FileLock.isStale(byPid, 60_000)).toBe(true);
    const l2 = await FileLock.acquire(byPid, { timeoutMs: 500, staleMs: 60_000 });
    await l2.release();
  });

  it('does not remove a lock it no longer owns', async () => {
    const lockPath = path.join(fresh(), LOCK_FILE);
    const l = await FileLock.acquire(lockPath);
    await fs.writeFile(lockPath, JSON.stringify({ token: 'someone-else', pid: process.pid, hostname: os.hostname(), createdAt: '' }));
    await l.release();
    await expect(fs.access(lockPath)).resolves.toBeUndefined();
  });
});

describe('FileSystemSyncStore', () => {
  it('round-trips snapshots with content-hash revisions and the documented layout', async () => {
    const root = fresh();
    const store = new FileSystemSyncStore(root);
    expect(await store.readSnapshot('My Col')).toBeNull();
    const r = await store.writeSnapshot('My Col', snap('My Col', { r1: 'a', r2: 'b' }), null);
    expect(r.status).toBe('ok');
    const dir = store.collectionDir('My Col');
    expect(path.basename(dir)).toBe(encodeFileName('My Col'));
    expect((await fs.readdir(dir)).sort()).toEqual(['entities', 'manifest.json', 'tombstones.json']);
    expect((await fs.readdir(path.join(dir, 'entities'))).sort()).toEqual([`${encodeFileName('My Col')}.json`, 'r1.json', 'r2.json'].sort());
    const back = await store.readSnapshot('My Col');
    expect(back?.revision).toBe(r.status === 'ok' ? r.revision : '');
    expect(Object.keys(back!.entities).sort()).toEqual(['My Col', 'r1', 'r2']);
    // Same content → same revision; different content → different revision.
    const same = await store.writeSnapshot('My Col', snap('My Col', { r1: 'a', r2: 'b' }));
    expect(same.status === 'ok' && same.revision).toBe(r.status === 'ok' && r.revision);
    const removed = await store.writeSnapshot('My Col', snap('My Col', { r1: 'a' }));
    expect(removed.status === 'ok' && removed.revision).not.toBe(r.status === 'ok' && r.revision);
    expect((await fs.readdir(path.join(dir, 'entities'))).sort()).toEqual([`${encodeFileName('My Col')}.json`, 'r1.json'].sort());
    expect((await store.listCollections()).map((c) => c.collectionId)).toEqual(['My Col']);
  });

  it('enforces optimistic concurrency between concurrent writers', async () => {
    const root = fresh();
    const a = new FileSystemSyncStore(root, { lock: { retryDelayMs: 5 } });
    const b = new FileSystemSyncStore(root, { lock: { retryDelayMs: 5 } });
    const first = await a.writeSnapshot('c', snap('c', { r: 'base' }), null);
    const base = first.status === 'ok' ? first.revision : '';
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).writeSnapshot('c', snap('c', { r: `writer ${i}` }), base)),
    );
    expect(results.filter((x) => x.status === 'ok')).toHaveLength(1);
    const winner = results.find((x) => x.status === 'ok')!;
    for (const loser of results.filter((x) => x.status === 'conflict')) {
      expect(loser).toMatchObject({ status: 'conflict', remoteRevision: winner.status === 'ok' ? winner.revision : '' });
    }
    expect(await a.writeSnapshot('c', snap('c', {}), null)).toMatchObject({ status: 'conflict' });
  });

  it('rolls an interrupted write forward once the journal is complete', async () => {
    const root = fresh();
    const good = new FileSystemSyncStore(root);
    await good.writeSnapshot('c', snap('c', { r1: 'v1', r2: 'v1' }));
    const crashing = new FileSystemSyncStore(root, {
      hooks: {
        afterApplyFile: (i) => {
          if (i === 1) throw new Error('power loss');
        },
      },
    });
    await expect(crashing.writeSnapshot('c', snap('c', { r1: 'v2', r2: 'v2', r3: 'v2' }))).rejects.toThrow();
    // Old manifest is still the commit point, but r1/r2 files already changed → direct read is inconsistent…
    await expect(readCollectionDir(good.collectionDir('c'), 'c')).rejects.toMatchObject({ code: 'INVALID_DATA' });
    // …and the store recovers by completing the journal.
    const after = await good.readSnapshot('c');
    expect(Object.keys(after!.entities).sort()).toEqual(['c', 'r1', 'r2', 'r3']);
    expect((after!.entities.r1!.data as { name: string }).name).toBe('v2');
    await expect(fs.access(path.join(good.collectionDir('c'), STAGING_DIR))).rejects.toThrow();
  });

  it('discards an incomplete journal (crash before the plan was written)', async () => {
    const root = fresh();
    const store = new FileSystemSyncStore(root);
    const w = await store.writeSnapshot('c', snap('c', { r1: 'v1' }));
    const staging = path.join(store.collectionDir('c'), STAGING_DIR);
    await fs.mkdir(path.join(staging, 'entities'), { recursive: true });
    await fs.writeFile(path.join(staging, 'entities', 'r1.json'), '{"half":');
    expect(await recoverCollectionDir(store.collectionDir('c'))).toBe('discarded');
    const back = await store.readSnapshot('c');
    expect(back?.revision).toBe(w.status === 'ok' ? w.revision : '');
  });

  it('detects tampered entity files', async () => {
    const store = new FileSystemSyncStore(fresh());
    await store.writeSnapshot('c', snap('c', { r1: 'v1' }));
    const f = path.join(store.collectionDir('c'), 'entities', 'r1.json');
    const json = JSON.parse(await fs.readFile(f, 'utf8'));
    json.data.name = 'tampered';
    await fs.writeFile(f, JSON.stringify(json));
    await expect(store.readSnapshot('c')).rejects.toMatchObject({ code: 'INVALID_DATA' });
  });

  it('reports a missing parent folder as unavailable', async () => {
    const store = new FileSystemSyncStore(path.join(fresh(), 'missing-drive', 'sync'));
    const health = await store.probe();
    expect(health.ok).toBe(false);
    await expect(store.writeSnapshot('c', snap('c', {}))).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
  });
});
