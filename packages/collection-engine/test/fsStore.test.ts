import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollection, createEnvironment, createFolder, createRequest, kv, type Collection } from '@reqvyn/core';
import { FileSystemStore, MemoryStore, FileLock, atomicWriteFile } from '../src/index.js';

let root: string;
let store: FileSystemStore;
beforeEach(async () => {
  root = join(mkdtempSync(join(tmpdir(), 'reqvyn-store-')), '.reqvyn');
  store = new FileSystemStore(root);
  await store.init();
});

function sample(): Collection {
  const c = createCollection({ name: 'My API' });
  const f = createFolder({ name: 'Users', parentId: null });
  const r1 = createRequest({ name: 'List users', parentId: f.id, url: '{{base}}/users' });
  const r2 = createRequest({ name: 'Health', parentId: null, url: '{{base}}/health' });
  return { ...c, variables: [kv('base', 'http://localhost'), kv('apiKey', 'super-secret', { secret: true })], folders: [f], requests: [r1, r2] };
}

describe('FileSystemStore', () => {
  it('writes one file per entity with readable names and round-trips', async () => {
    const c = sample();
    await store.saveCollection(c);
    const dirs = readdirSync(join(root, 'collections'));
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^my-api\.[a-z0-9]{8}$/);
    const reqFiles = readdirSync(join(root, 'collections', dirs[0]!, 'requests'));
    expect(reqFiles.sort()[0]).toMatch(/^health\./);
    const loaded = await store.loadCollection(c.id);
    expect(loaded.name).toBe('My API');
    expect(loaded.requests.map((r) => r.name).sort()).toEqual(['Health', 'List users']);
    expect(loaded.folders[0]?.name).toBe('Users');
    expect(await store.listCollections()).toEqual([{ id: c.id, name: 'My API', requestCount: 2, folderCount: 1 }]);
    expect(existsSync(join(root, '.gitignore'))).toBe(true);
  });

  it('never writes secret variable values to disk', async () => {
    const c = sample();
    await store.saveCollection(c);
    const env = createEnvironment({ name: 'Dev', variables: [kv('token', 'abc-secret-xyz', { secret: true }), kv('host', 'dev')] });
    await store.saveEnvironment(env);
    const all = JSON.stringify(readAllFiles(root));
    expect(all).not.toContain('super-secret');
    expect(all).not.toContain('abc-secret-xyz');
    const [loadedEnv] = await store.listEnvironments();
    expect(loadedEnv?.variables.find((v) => v.key === 'token')).toMatchObject({ secret: true, value: '' });
  });

  it('renames files when entities are renamed and removes deleted ones', async () => {
    const c = sample();
    await store.saveCollection(c);
    const r = c.requests[1]!;
    await store.saveRequest(c.id, { ...r, name: 'Ping' });
    const dir = join(root, 'collections', readdirSync(join(root, 'collections'))[0]!, 'requests');
    expect(readdirSync(dir).some((f) => f.startsWith('ping.'))).toBe(true);
    expect(readdirSync(dir).some((f) => f.startsWith('health.'))).toBe(false);
    await store.deleteRequest(c.id, r.id);
    expect(readdirSync(dir)).toHaveLength(1);
    await store.saveCollection({ ...c, requests: [] });
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('detects external modifications as CONFLICT and allows forced overwrite', async () => {
    const c = sample();
    await store.saveCollection(c);
    await store.loadCollection(c.id);
    const r = c.requests[0]!;
    const dir = join(root, 'collections', readdirSync(join(root, 'collections'))[0]!, 'requests');
    const file = join(dir, readdirSync(dir).find((f) => f.startsWith('list-users'))!);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...data, url: 'http://changed-externally' }, null, 2));
    await expect(store.saveRequest(c.id, { ...r, url: 'http://mine' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await store.saveRequest(c.id, { ...r, url: 'http://mine' }, { force: true });
    expect(JSON.parse(readFileSync(file, 'utf8')).url).toBe('http://mine');
  });

  it('reports invalid files without losing the rest', async () => {
    const c = sample();
    await store.saveCollection(c);
    const dir = join(root, 'collections', readdirSync(join(root, 'collections'))[0]!, 'requests');
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    const loaded = await store.loadCollection(c.id);
    expect(loaded.requests).toHaveLength(2);
    expect(store.getProblems().some((p) => p.file.endsWith('broken.json'))).toBe(true);
    expect(existsSync(join(dir, 'broken.json'))).toBe(true); // never deleted silently
  });

  it('refuses files from a newer schema version', async () => {
    const c = sample();
    await store.saveCollection(c);
    const dir = join(root, 'collections', readdirSync(join(root, 'collections'))[0]!);
    const info = JSON.parse(readFileSync(join(dir, 'collection.json'), 'utf8'));
    writeFileSync(join(dir, 'collection.json'), JSON.stringify({ ...info, schemaVersion: 99 }));
    await expect(store.loadCollection(c.id)).rejects.toThrow(/newer REQVYN/);
  });

  it('recovers from interrupted writes', async () => {
    const dir = join(root, 'environments');
    writeFileSync(join(dir, '.orphan.json.deadbeef.reqvyn-tmp'), JSON.stringify(createEnvironment({ name: 'Recovered' })));
    writeFileSync(join(dir, 'kept.json'), '{"id":"x"}');
    writeFileSync(join(dir, '.kept.json.cafebabe.reqvyn-tmp'), '{"partial');
    const r = await store.recover();
    expect(r.promoted.map((p) => p.endsWith('orphan.json'))).toEqual([true]);
    expect(r.removed).toHaveLength(1);
    expect(readFileSync(join(dir, 'kept.json'), 'utf8')).toBe('{"id":"x"}');
  });

  it('does not rewrite unchanged files', async () => {
    const c = sample();
    await store.saveCollection(c);
    const before = snapshotMtimes(root);
    await new Promise((r) => setTimeout(r, 20));
    await store.saveCollection(c);
    expect(snapshotMtimes(root)).toEqual(before);
  });

  it('migrates legacy v0 nested documents and keeps a backup', async () => {
    const id = 'legacy-1';
    const dir = join(root, 'collections', 'legacy');
    await atomicWriteFile(join(dir, 'collection.json'), JSON.stringify({ id, name: 'Legacy' }));
    const loaded = await store.loadCollection(id);
    expect(loaded.name).toBe('Legacy');
    expect(existsSync(join(root, '.backup'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'collection.json'), 'utf8')).schemaVersion).toBe(1);
  });

  it('emits external change events but ignores its own writes', async () => {
    const c = sample();
    await store.saveCollection(c);
    await store.loadCollection(c.id);
    const events: unknown[] = [];
    store.onDidChange((e) => events.push(e));
    const dir = join(root, 'collections', readdirSync(join(root, 'collections'))[0]!);
    await store.notifyFileChanged(join(dir, 'collection.json'));
    expect(events).toHaveLength(0);
    writeFileSync(join(dir, 'collection.json'), readFileSync(join(dir, 'collection.json'), 'utf8').replace('My API', 'Renamed'));
    await store.notifyFileChanged(join(dir, 'collection.json'));
    expect(events).toEqual([{ kind: 'collection', id: c.id, origin: 'external' }]);
  });

  it('serializes concurrent writes from two store instances via the lock', async () => {
    const c = sample();
    await store.saveCollection(c);
    const other = new FileSystemStore(root);
    await other.loadCollection(c.id);
    const writes = Array.from({ length: 20 }, (_, i) => {
      const s = i % 2 ? store : other;
      return s.saveRequest(c.id, createRequest({ name: `R${i}`, parentId: null }));
    });
    await Promise.all(writes);
    expect((await store.loadCollection(c.id)).requests).toHaveLength(22);
  });

  it('handles thousands of requests within reasonable time', async () => {
    const c = createCollection({ name: 'Big' });
    const requests = Array.from({ length: 2000 }, (_, i) => createRequest({ name: `Request ${i}`, parentId: null, sortKey: i }));
    const t0 = Date.now();
    await store.saveCollection({ ...c, requests });
    const loaded = await store.loadCollection(c.id);
    const elapsed = Date.now() - t0;
    expect(loaded.requests).toHaveLength(2000);
    expect(elapsed).toBeLessThan(20_000);
  }, 120_000);
});

describe('FileLock', () => {
  it('breaks stale locks and times out on held locks', async () => {
    const file = join(root, 'test.lock');
    writeFileSync(file, 'stale');
    const lock = new FileLock(file, { staleMs: 0 });
    const release = await lock.acquire();
    const second = new FileLock(file, { staleMs: 60_000, timeoutMs: 100 });
    await expect(second.acquire()).rejects.toMatchObject({ code: 'CONFLICT' });
    await release();
    expect(existsSync(file)).toBe(false);
  });
});

describe('MemoryStore', () => {
  it('implements the store contract', async () => {
    const m = new MemoryStore();
    const c = sample();
    await m.saveCollection(c);
    await m.saveRequest(c.id, createRequest({ name: 'x' }));
    expect((await m.loadCollection(c.id)).requests).toHaveLength(3);
    await m.deleteCollection(c.id);
    expect(await m.listCollections()).toEqual([]);
  });
});

function readAllFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) {
      const p = join(e.parentPath ?? (e as unknown as { path: string }).path, e.name);
      out[p] = readFileSync(p, 'utf8');
    }
  }
  return out;
}

function snapshotMtimes(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of Object.keys(readAllFiles(dir))) out[p] = statSync(p).mtimeMs;
  return out;
}
