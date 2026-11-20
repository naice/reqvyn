import { execFileSync } from 'node:child_process';
import { mkdtempSync, promises as fs, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEntity, emptySnapshot, type SyncProviderContext, type SyncSnapshot } from '@reqvyn/provider-sdk';
import { GitSyncProvider, classifyGitFailure, normalizeSubdirectory, sanitizeGitOutput, type GitProviderOptions } from '../src/index.js';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitAvailable();
let tmp = '';
let gitEnv: Record<string, string> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...gitEnv }, encoding: 'utf8' }).trim();
}

function ctx(config: Record<string, string | number | undefined>, secrets: Record<string, string> = {}): SyncProviderContext {
  const values: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(config)) if (v !== undefined) values[k] = v;
  return {
    instanceId: 'git-test',
    config: values,
    secrets: { get: async (k) => secrets[k], set: async () => undefined, delete: async () => undefined },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    progress: { report() {} },
  };
}

function snapshot(collectionId: string, requests: Record<string, string>): SyncSnapshot {
  const s = emptySnapshot(collectionId);
  s.label = `Collection ${collectionId}`;
  s.entities[collectionId] = createEntity('collection', { id: collectionId, name: `Collection ${collectionId}` });
  for (const [id, name] of Object.entries(requests)) s.entities[id] = createEntity('request', { id, name, parentId: null, url: `https://example.test/${id}` });
  return s;
}

async function provider(config: Record<string, string | number | undefined>, options: GitProviderOptions = {}, secrets: Record<string, string> = {}) {
  const p = new GitSyncProvider({ gitEnv, ...options });
  await p.initialize(ctx({ authorName: 'Test', authorEmail: 'test@example.test', ...config }, secrets));
  return p;
}

describe.skipIf(!HAS_GIT)('GitSyncProvider', { timeout: 90_000 }, () => {
  let bare = '';

  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'reqvyn-git-'));
    const globalCfg = path.join(tmp, 'gitconfig');
    writeFileSync(globalCfg, '[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
    gitEnv = { GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1', HOME: tmp };
    bare = path.join(tmp, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: { ...process.env, ...gitEnv } });
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('works without any remote (local history only)', async () => {
    const repo = path.join(tmp, 'local-only');
    const p = await provider({ repositoryPath: repo, subdirectory: 'sync/collections' });
    expect(await p.pull('c1')).toBeNull();
    const r1 = await p.push('c1', snapshot('c1', { r1: 'one' }), null);
    expect(r1.status).toBe('ok');
    const sha1 = r1.status === 'ok' ? r1.revision : '';
    expect(sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha1);

    const pulled = await p.pull('c1');
    expect(pulled?.revision).toBe(sha1);
    expect(Object.keys(pulled!.entities).sort()).toEqual(['c1', 'r1']);
    expect((await p.getRemoteManifest('c1'))?.revision).toBe(sha1);
    await fs.access(path.join(repo, 'sync', 'collections', 'c1', 'manifest.json'));

    // Optimistic concurrency against the commit SHA.
    expect((await p.push('c1', snapshot('c1', { r1: 'x' }), null)).status).toBe('conflict');
    expect((await p.push('c1', snapshot('c1', { r1: 'x' }), 'f'.repeat(40))).status).toBe('conflict');
    const r2 = await p.push('c1', snapshot('c1', { r1: 'two', r2: 'new' }), sha1);
    expect(r2.status).toBe('ok');
    // Pushing identical content does not create an empty commit.
    const r3 = await p.push('c1', snapshot('c1', { r1: 'two', r2: 'new' }), r2.status === 'ok' ? r2.revision : '');
    expect(r3).toEqual(r2);
    expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('2');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'log', '-1', '--format=%an <%ae>')).toBe('Test <test@example.test>');

    expect((await p.listRemoteCollections()).map((c) => c.collectionId)).toEqual(['c1']);
    await p.deleteRemoteCollection('c1', r2.status === 'ok' ? r2.revision : '');
    expect(await p.pull('c1')).toBeNull();
    await p.dispose();
  });

  it('syncs two clones through a bare repository and reports non-fast-forward as conflict', async () => {
    const a = await provider({ remoteUrl: bare, cloneDirectory: path.join(tmp, 'clone-a') });
    const b = await provider({ remoteUrl: bare, cloneDirectory: path.join(tmp, 'clone-b') });
    expect((await a.testConnection()).ok).toBe(true);
    expect(await b.pull('shared')).toBeNull(); // empty bare repository

    const ra = await a.push('shared', snapshot('shared', { r1: 'from A' }), null);
    expect(ra.status).toBe('ok');
    const revA = ra.status === 'ok' ? ra.revision : '';
    expect(git(bare, 'rev-parse', 'refs/heads/main')).toBe(revA);

    const pb = await b.pull('shared');
    expect(pb?.revision).toBe(revA);
    expect((pb!.entities.r1!.data as { name: string }).name).toBe('from A');

    const rb = await b.push('shared', snapshot('shared', { r1: 'from B' }), revA);
    expect(rb.status).toBe('ok');
    const revB = rb.status === 'ok' ? rb.revision : '';

    // A still believes revA is current → conflict, nothing overwritten.
    const stale = await a.push('shared', snapshot('shared', { r1: 'stale A' }), revA);
    expect(stale).toMatchObject({ status: 'conflict', remoteRevision: revB });
    expect(git(bare, 'rev-parse', 'refs/heads/main')).toBe(revB);
    expect(((await a.pull('shared'))!.entities.r1!.data as { name: string }).name).toBe('from B');

    // Another collection pushed by B does not change the revision of "shared".
    const other = await b.push('other', snapshot('other', { o1: 'x' }), null);
    expect(other.status).toBe('ok');
    expect((await a.getRemoteManifest('shared'))?.revision).toBe(revB);

    // Race: B pushes the SAME collection between A's fetch and A's push → rejected push → conflict.
    let raced = false;
    const a2 = await provider(
      { remoteUrl: bare, cloneDirectory: path.join(tmp, 'clone-a') },
      {
        hooks: {
          afterStage: async () => {
            if (raced) return;
            raced = true;
            const r = await b.push('shared', snapshot('shared', { r1: 'B wins race' }), revB);
            expect(r.status).toBe('ok');
          },
        },
      },
    );
    const lost = await a2.push('shared', snapshot('shared', { r1: 'A loses race' }), revB);
    expect(lost.status).toBe('conflict');
    const remoteHead = git(bare, 'rev-parse', 'refs/heads/main');
    expect(lost.status === 'conflict' && lost.remoteRevision).toBe(remoteHead);
    // The rejected local commit was undone: clone A is clean and equal to the remote.
    expect(git(path.join(tmp, 'clone-a'), 'status', '--porcelain')).toBe('');
    expect(git(path.join(tmp, 'clone-a'), 'rev-parse', 'HEAD')).toBe(remoteHead);

    // Race on a DIFFERENT collection: the rejected push is retried transparently.
    let raced2 = false;
    const a3 = await provider(
      { remoteUrl: bare, cloneDirectory: path.join(tmp, 'clone-a') },
      {
        hooks: {
          afterStage: async () => {
            if (raced2) return;
            raced2 = true;
            const cur = await b.getRemoteManifest('other');
            expect((await b.push('other', snapshot('other', { o1: 'changed' }), cur!.revision)).status).toBe('ok');
          },
        },
      },
    );
    const sharedRev = (await a3.getRemoteManifest('shared'))!.revision;
    const ok = await a3.push('shared', snapshot('shared', { r1: 'A after race' }), sharedRev);
    expect(ok.status).toBe('ok');
    expect(git(bare, 'rev-parse', 'refs/heads/main')).toBe(ok.status === 'ok' ? ok.revision : '');
    expect(((await b.pull('other'))!.entities.o1!.data as { name: string }).name).toBe('changed');
    expect(((await b.pull('shared'))!.entities.r1!.data as { name: string }).name).toBe('A after race');
  });

  it('recovers from an interrupted write (crash between files)', async () => {
    const repo = path.join(tmp, 'crash');
    const p = await provider({ repositoryPath: repo });
    const r1 = await p.push('c', snapshot('c', { r1: 'v1', r2: 'v1' }), null);
    expect(r1.status).toBe('ok');
    const crashing = await provider(
      { repositoryPath: repo },
      {
        hooks: {
          afterApplyFile: (i) => {
            if (i === 0) throw new Error('simulated crash');
          },
        },
      },
    );
    await expect(crashing.push('c', snapshot('c', { r1: 'v2', r2: 'v2', r3: 'v2' }), r1.status === 'ok' ? r1.revision : '')).rejects.toThrow();
    const after = await p.pull('c');
    expect(after?.revision).toBe(r1.status === 'ok' ? r1.revision : '');
    expect(Object.keys(after!.entities).sort()).toEqual(['c', 'r1', 'r2']);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('keeps tokens out of errors and argv', async () => {
    const p = await provider({ remoteUrl: 'https://127.0.0.1:9/never/repo.git', cloneDirectory: path.join(tmp, 'clone-http'), timeoutMs: 15000 }, {}, { token: 'SUPERSECRET' });
    const health = await p.testConnection();
    expect(health.ok).toBe(false);
    expect(health.message).not.toContain('SUPERSECRET');
    await expect(p.pull('x')).rejects.toMatchObject({ code: expect.stringMatching(/NETWORK|CONFIG|INTERNAL/) });
  });
});

describe('git helpers', () => {
  it('sanitizes credentials and classifies failures', () => {
    expect(sanitizeGitOutput('fatal: unable to access https://user:tok@host/x', ['tok'])).toBe('fatal: unable to access https://***@host/x');
    expect(classifyGitFailure('fatal: Authentication failed for')).toBe('AUTH');
    expect(classifyGitFailure('fatal: Could not resolve host: x')).toBe('NETWORK');
    expect(classifyGitFailure("fatal: 'x' does not appear to be a git repository")).toBe('CONFIG');
  });

  it('validates subdirectories', () => {
    expect(normalizeSubdirectory('a\\b//c/')).toBe('a/b/c');
    expect(normalizeSubdirectory('')).toBe('');
    expect(() => normalizeSubdirectory('../x')).toThrow();
    expect(() => normalizeSubdirectory('.git/hooks')).toThrow();
  });

  it('rejects unsafe configuration', async () => {
    const p = new GitSyncProvider();
    await expect(p.initialize(ctx({ remoteUrl: 'ext::sh -c touch% /tmp/pwned', cloneDirectory: path.join(os.tmpdir(), 'x') }))).rejects.toMatchObject({ code: 'CONFIG' });
    await expect(new GitSyncProvider().initialize(ctx({ repositoryPath: path.join(os.tmpdir(), 'x'), branch: '-evil' }))).rejects.toMatchObject({ code: 'CONFIG' });
    await expect(new GitSyncProvider().initialize(ctx({}))).rejects.toMatchObject({ code: 'CONFIG' });
  });
});
