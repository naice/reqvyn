import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemorySecretVault, createCollection, createFolder, createRequest, secretKeys } from '@reqvyn/core';
import { contentHash } from '@reqvyn/shared/node';
import {
  SyncProviderError,
  canonicalJson,
  sha256Hex,
  type SyncProvider,
  type SyncProviderContext,
  type SyncProviderFactory,
} from '@reqvyn/provider-sdk';
import {
  FileSyncStateStore,
  MemorySyncProvider,
  SyncProviderRegistry,
  collectionToSnapshot,
  createScopedSecrets,
  initialSyncState,
  snapshotToCollection,
} from '../src/index.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'reqvyn-sync-core-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('collection ↔ snapshot', () => {
  it('round-trips and uses the shared content hash', () => {
    const c = createCollection({ id: 'col', name: 'API' });
    const f = createFolder({ id: 'f1', name: 'Users', sortKey: 1 });
    c.folders.push(f);
    c.requests.push(createRequest({ id: 'r2', name: 'B', parentId: 'f1', sortKey: 2 }), createRequest({ id: 'r1', name: 'A', parentId: 'f1', sortKey: 1 }));
    const s = collectionToSnapshot(c);
    expect(Object.keys(s.entities).sort()).toEqual(['col', 'f1', 'r1', 'r2']);
    expect(s.entities.col!.kind).toBe('collection');
    expect(s.entities.col!.data).not.toHaveProperty('requests');
    expect(s.entities.r1!.hash).toBe(contentHash(s.entities.r1!.data));
    expect(sha256Hex(canonicalJson(s.entities.r1!.data))).toBe(s.entities.r1!.hash);
    const back = snapshotToCollection(s);
    expect(back.requests.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(back.name).toBe('API');
  });

  it('repairs orphans and folder cycles', () => {
    const c = createCollection({ id: 'col' });
    c.folders.push(createFolder({ id: 'a', parentId: 'b' }), createFolder({ id: 'b', parentId: 'a' }));
    c.requests.push(createRequest({ id: 'r', parentId: 'missing' }));
    const back = snapshotToCollection(collectionToSnapshot(c));
    expect(back.requests[0]!.parentId).toBeNull();
    expect(back.folders.some((x) => x.parentId === null)).toBe(true);
  });

  it('rejects duplicate ids', () => {
    const c = createCollection({ id: 'col' });
    c.requests.push(createRequest({ id: 'x' }));
    c.folders.push(createFolder({ id: 'x' }));
    expect(() => collectionToSnapshot(c)).toThrow();
  });
});

describe('FileSyncStateStore', () => {
  it('persists state atomically and quarantines corrupt files', async () => {
    const dir = path.join(tmp, 'state');
    const store = new FileSyncStateStore(dir);
    expect(await store.load('inst/1', 'col:1')).toBeNull();
    const st = { ...initialSyncState('inst/1', 'col:1'), lastRevision: 'r1', lastStatus: 'synced' as const };
    await store.save(st);
    expect(await new FileSyncStateStore(dir).load('inst/1', 'col:1')).toMatchObject({ lastRevision: 'r1' });
    expect(await store.list('inst/1')).toEqual(['col:1']);
    const sub = (await fs.readdir(dir))[0]!;
    const file = path.join(dir, sub, (await fs.readdir(path.join(dir, sub)))[0]!);
    await fs.writeFile(file, '{ broken');
    expect(await store.load('inst/1', 'col:1')).toBeNull();
    expect((await fs.readdir(path.join(dir, sub))).some((n) => n.includes('.corrupt-'))).toBe(true);
    await store.delete('inst/1', 'col:1');
  });
});

describe('scoped secrets and registry', () => {
  it('scopes secrets per instance', async () => {
    const vault = new MemorySecretVault();
    const a = createScopedSecrets(vault, 'a');
    const b = createScopedSecrets(vault, 'b');
    await a.set('token', 'A-SECRET');
    expect(await a.get('token')).toBe('A-SECRET');
    expect(await b.get('token')).toBeUndefined();
    expect(await vault.get(secretKeys.syncProvider('a', 'token'))).toBe('A-SECRET');
    await expect(a.get('../b.token')).rejects.toThrow();
    await expect(a.get('b.token')).rejects.toThrow();
  });

  function factory(id: string, impl: Partial<SyncProvider> = {}, seen?: (ctx: SyncProviderContext) => void): SyncProviderFactory {
    return {
      descriptor: {
        id,
        displayName: id,
        capabilities: { read: true, write: true, optimisticConcurrency: true, list: true, delete: false, auth: false },
        configSchema: [
          { key: 'url', label: 'URL', type: 'url', required: true },
          { key: 'token', label: 'Token', type: 'secret' },
        ],
      },
      create() {
        const p = new MemorySyncProvider();
        Object.defineProperty(p, 'id', { value: id });
        const init = p.initialize.bind(p);
        p.initialize = async (ctx) => {
          seen?.(ctx);
          await init(ctx);
        };
        return Object.assign(p, impl);
      },
    };
  }

  it('registers, rejects duplicates and unregisters', () => {
    const reg = new SyncProviderRegistry({ vault: new MemorySecretVault() });
    const events: string[] = [];
    reg.onDidChange((e) => events.push(`${e.type}:${e.providerId}`));
    const d = reg.register(factory('acme.one'), 'test');
    expect(() => reg.register(factory('acme.one'))).toThrow();
    expect(() => reg.register(factory('BAD ID'))).toThrow();
    expect(reg.list().map((x) => x.id)).toEqual(['acme.one']);
    expect(Object.isFrozen(reg.get('acme.one'))).toBe(true);
    d.dispose();
    expect(reg.has('acme.one')).toBe(false);
    expect(events).toEqual(['registered:acme.one', 'unregistered:acme.one']);
  });

  it('gives each instance only its own secrets and validated config', async () => {
    const vault = new MemorySecretVault();
    await vault.set(secretKeys.syncProvider('one', 'token'), 'secret-one');
    await vault.set(secretKeys.syncProvider('two', 'token'), 'secret-two');
    const reg = new SyncProviderRegistry({ vault });
    const contexts: SyncProviderContext[] = [];
    reg.register(factory('acme.p', {}, (c) => contexts.push(c)));
    await expect(reg.createInstance({ instanceId: 'one', providerId: 'acme.p', config: {} })).rejects.toThrow();
    await expect(reg.createInstance({ instanceId: 'one', providerId: 'acme.p', config: { url: 'https://x.test', token: 'inline' } })).rejects.toThrow();
    await reg.createInstance({ instanceId: 'one', providerId: 'acme.p', config: { url: 'https://x.test' } });
    await reg.createInstance({ instanceId: 'two', providerId: 'acme.p', config: { url: 'https://y.test' } });
    expect(await contexts[0]!.secrets.get('token')).toBe('secret-one');
    expect(await contexts[1]!.secrets.get('token')).toBe('secret-two');
    expect(Object.isFrozen(contexts[0]!.config)).toBe(true);
    expect(JSON.stringify(contexts[0]!.config)).not.toContain('secret');
    await expect(reg.createInstance({ instanceId: 'x', providerId: 'missing' })).rejects.toThrow();
  });

  it('isolates provider exceptions and validates provider output', async () => {
    const reg = new SyncProviderRegistry({ vault: new MemorySecretVault() });
    reg.register(
      factory('acme.bad', {
        pull: async () => {
          throw new TypeError('kaboom');
        },
        push: async () => ({ status: 'weird' }) as never,
        testConnection: async () => {
          throw new Error('nope');
        },
        getRemoteManifest: async () => {
          throw new SyncProviderError('NOT_FOUND', 'gone');
        },
      }),
    );
    const p = await reg.createInstance({ instanceId: 'bad', providerId: 'acme.bad', config: { url: 'https://x.test' } });
    await expect(p.pull('c')).rejects.toBeInstanceOf(SyncProviderError);
    await expect(p.push('c', { formatVersion: 1, collectionId: 'c', revision: null, entities: {}, tombstones: [] })).rejects.toMatchObject({ code: 'INVALID_DATA' });
    expect((await p.testConnection()).ok).toBe(false);
    expect(await p.getRemoteManifest('c')).toBeNull();
    await expect(p.deleteRemoteCollection('c')).rejects.toThrow(); // capability not declared
    await p.dispose();
    await expect(p.pull('c')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
