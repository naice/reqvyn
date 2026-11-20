import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createEntity, emptySnapshot, validateDescriptor, type SyncProviderContext } from '@reqvyn/provider-sdk';
import { LocalFolderSyncProvider, localFolderDescriptor, localFolderProviderFactory } from '../src/index.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'reqvyn-local-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function ctx(config: Record<string, string | number>, signal = new AbortController().signal): SyncProviderContext {
  return {
    instanceId: 'local',
    config,
    secrets: { get: async () => undefined, set: async () => undefined, delete: async () => undefined },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal,
    progress: { report() {} },
  };
}

function snap(name: string) {
  const s = emptySnapshot('col');
  s.entities.col = createEntity('collection', { id: 'col', name });
  return s;
}

describe('LocalFolderSyncProvider', () => {
  it('has a valid descriptor', () => {
    expect(validateDescriptor(localFolderDescriptor)).toEqual([]);
    expect(localFolderProviderFactory.create().id).toBe(localFolderDescriptor.id);
  });

  it('rejects missing or relative folders', async () => {
    await expect(new LocalFolderSyncProvider().initialize(ctx({}))).rejects.toMatchObject({ code: 'CONFIG' });
    await expect(new LocalFolderSyncProvider().initialize(ctx({ folderPath: 'relative/dir' }))).rejects.toMatchObject({ code: 'CONFIG' });
  });

  it('pushes, pulls, lists, deletes with optimistic concurrency', async () => {
    const p = new LocalFolderSyncProvider();
    await p.initialize(ctx({ folderPath: path.join(tmp, 'remote') }));
    expect((await p.testConnection()).ok).toBe(true);
    expect(await p.pull('col')).toBeNull();
    expect(await p.getRemoteManifest('col')).toBeNull();
    const r = await p.push('col', snap('one'), null);
    expect(r.status).toBe('ok');
    const rev = r.status === 'ok' ? r.revision : '';
    expect((await p.getRemoteManifest('col'))?.revision).toBe(rev);
    expect((await p.pull('col'))?.revision).toBe(rev);
    expect(await p.push('col', snap('two'), null)).toMatchObject({ status: 'conflict', remoteRevision: rev });
    expect(await p.push('col', snap('two'), 'nope')).toMatchObject({ status: 'conflict' });
    const r2 = await p.push('col', snap('two'), rev);
    expect(r2.status).toBe('ok');
    expect((await p.listRemoteCollections()).map((c) => c.collectionId)).toEqual(['col']);
    await expect(p.deleteRemoteCollection('col', rev)).rejects.toMatchObject({ code: 'CONFLICT' });
    await p.deleteRemoteCollection('col', r2.status === 'ok' ? r2.revision : '');
    expect(await p.pull('col')).toBeNull();
    await p.dispose();
  });

  it('honours cancellation', async () => {
    const p = new LocalFolderSyncProvider();
    await p.initialize(ctx({ folderPath: path.join(tmp, 'cancel') }));
    const ac = new AbortController();
    ac.abort();
    await expect(p.pull('col', { signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
