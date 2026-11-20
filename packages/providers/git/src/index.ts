/**
 * `@reqvyn/provider-git` – sync through a Git repository using the git CLI.
 *
 * Layout inside the repository (same as the Local Folder provider):
 *
 * ```text
 * <subdirectory>/<collectionId>/manifest.json, entities/<id>.json, tombstones.json
 * ```
 *
 * The revision of a collection is the SHA of the last commit that touched its directory, so
 * pushes of other collections do not invalidate it. Each push is one commit; with a remote it is
 * pushed immediately, and a rejected (non-fast-forward) push whose collection changed remotely is
 * reported as a conflict. Without a remote the repository is purely local (history only).
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  SyncProviderError,
  computeSnapshotRevision,
  configNumber,
  configString,
  throwIfCancelled,
  toSyncProviderError,
  type RemoteCollectionInfo,
  type SyncHealthResult,
  type SyncManifest,
  type SyncOperationOptions,
  type SyncProvider,
  type SyncProviderCapabilities,
  type SyncProviderContext,
  type SyncProviderDescriptor,
  type SyncProviderFactory,
  type SyncPushResult,
  type SyncSnapshot,
} from '@reqvyn/provider-sdk';
import {
  FileLock,
  MANIFEST_FILE,
  cleanTempFiles,
  encodeFileName,
  readCollectionDir,
  readManifest,
  writeCollectionDir,
  type WriteHooks,
} from '@reqvyn/provider-filesystem';
import { GitRunner, isPushRejected, sanitizeGitOutput, type GitResult } from './git.js';

export * from './git.js';

export const GIT_PROVIDER_ID = 'reqvyn.git';

export const gitCapabilities: SyncProviderCapabilities = Object.freeze({
  read: true,
  write: true,
  optimisticConcurrency: true,
  list: true,
  delete: true,
  auth: false,
});

export const gitDescriptor: SyncProviderDescriptor = {
  id: GIT_PROVIDER_ID,
  displayName: 'Git Repository',
  description: 'Synchronize collections through a Git repository (local, bare, or hosted). Uses the git CLI.',
  version: '0.1.0',
  capabilities: gitCapabilities,
  configSchema: [
    { key: 'repositoryPath', label: 'Repository path', type: 'path', description: 'Existing working copy (initialized if it is not a repository). Leave empty to clone the remote URL.' },
    { key: 'remoteUrl', label: 'Remote URL', type: 'string', description: 'Remote to fetch from / push to (https, ssh or a path to a bare repository). Optional.' },
    { key: 'cloneDirectory', label: 'Clone directory', type: 'path', description: 'Where to clone the remote when no repository path is given (default: extension storage).' },
    { key: 'remoteName', label: 'Remote name', type: 'string', default: 'origin' },
    { key: 'branch', label: 'Branch', type: 'string', default: 'main' },
    { key: 'subdirectory', label: 'Subdirectory', type: 'string', default: 'reqvyn', description: 'Folder inside the repository that holds the collections.' },
    { key: 'authorName', label: 'Commit author name', type: 'string' },
    { key: 'authorEmail', label: 'Commit author email', type: 'string' },
    { key: 'username', label: 'HTTPS user name', type: 'string', description: 'Used together with the token for HTTPS remotes.' },
    { key: 'token', label: 'HTTPS access token', type: 'secret', description: 'Optional. Sent as an HTTP header, never written to the repository config.' },
    { key: 'timeoutMs', label: 'Git command timeout (ms)', type: 'number', default: 120_000 },
  ],
};

export interface GitProviderOptions {
  /** Git executable path (default `git` from PATH). */
  gitExecutable?: string;
  /** Extra environment for every git command (tests use it to isolate global config). */
  gitEnv?: Record<string, string | undefined>;
  /** Lock wait timeout for concurrent writers on the same working copy (default 30 s). */
  lockTimeoutMs?: number;
  /** Retries of a rejected push when the collection itself did not change remotely (default 3). */
  pushRaceRetries?: number;
  hooks?: WriteHooks;
}

interface ResolvedConfig {
  workTree: string;
  remoteUrl?: string;
  remoteName: string;
  branch: string;
  subdirectory: string;
  authorName?: string;
  authorEmail?: string;
}

const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]+(?<!\.lock)(?<![./])$/;
const REMOTE_NAME_RE = /^(?!-)[A-Za-z0-9._-]{1,64}$/;

/** Validate and normalize a repository-relative directory (posix, no `..`, not inside `.git`). */
export function normalizeSubdirectory(input: string | undefined): string {
  const parts = (input ?? '').split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..' || p.toLowerCase() === '.git' || p.startsWith('-')) {
      throw new SyncProviderError('CONFIG', `Invalid subdirectory segment "${p}"`);
    }
  }
  return parts.join('/');
}

function validateRemoteUrl(url: string): void {
  if (url.startsWith('-')) throw new SyncProviderError('CONFIG', 'Invalid remote URL');
  if (/^(ext|fd)::/i.test(url)) throw new SyncProviderError('CONFIG', 'Remote helper transports (ext::, fd::) are not allowed');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export class GitSyncProvider implements SyncProvider {
  readonly id = GIT_PROVIDER_ID;
  readonly displayName = 'Git Repository';
  readonly capabilities = gitCapabilities;

  private context: SyncProviderContext | undefined;
  private cfg: ResolvedConfig | undefined;
  private git: GitRunner | undefined;
  private ready: Promise<void> | undefined;
  private gitDir = '';
  private identityEnv: Record<string, string> = {};
  private authEnv: Record<string, string> = {};
  private disposed = false;

  constructor(private readonly options: GitProviderOptions = {}) {}

  // ------------------------------------------------------------------ setup

  async initialize(context: SyncProviderContext): Promise<void> {
    this.context = context;
    const c = context.config;
    const repositoryPath = configString(c, 'repositoryPath');
    const remoteUrl = configString(c, 'remoteUrl');
    const cloneDirectory = configString(c, 'cloneDirectory');
    if (!repositoryPath && !remoteUrl) throw new SyncProviderError('CONFIG', 'Git provider: configure a repository path or a remote URL');
    if (remoteUrl) validateRemoteUrl(remoteUrl);
    let workTree: string;
    if (repositoryPath) workTree = repositoryPath;
    else if (cloneDirectory) workTree = cloneDirectory;
    else if (context.storagePath) workTree = path.join(context.storagePath, 'git', encodeFileName(context.instanceId));
    else throw new SyncProviderError('CONFIG', 'Git provider: a clone directory is required');
    if (!path.isAbsolute(workTree)) throw new SyncProviderError('CONFIG', 'Git provider: repository / clone path must be absolute');
    const remoteName = configString(c, 'remoteName') ?? 'origin';
    const branch = configString(c, 'branch') ?? 'main';
    if (!REMOTE_NAME_RE.test(remoteName)) throw new SyncProviderError('CONFIG', 'Git provider: invalid remote name');
    if (!BRANCH_RE.test(branch)) throw new SyncProviderError('CONFIG', 'Git provider: invalid branch name');
    this.cfg = {
      workTree: path.resolve(workTree),
      remoteUrl,
      remoteName,
      branch,
      subdirectory: normalizeSubdirectory(configString(c, 'subdirectory') ?? 'reqvyn'),
      authorName: configString(c, 'authorName'),
      authorEmail: configString(c, 'authorEmail'),
    };
    const token = await context.secrets.get('token');
    const redact: string[] = [];
    if (token) {
      redact.push(token);
      if (remoteUrl && /^https?:\/\//i.test(remoteUrl)) {
        const user = configString(c, 'username') ?? 'x-access-token';
        const basic = Buffer.from(`${user}:${token}`).toString('base64');
        redact.push(basic);
        // Passed through GIT_CONFIG_* env (never argv / never .git/config), scoped to the remote origin.
        const origin = new URL(remoteUrl).origin;
        const n = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
        this.authEnv = {
          GIT_CONFIG_COUNT: String(n + 1),
          [`GIT_CONFIG_KEY_${n}`]: `http.${origin}/.extraHeader`,
          [`GIT_CONFIG_VALUE_${n}`]: `Authorization: Basic ${basic}`,
        };
      }
    }
    this.git = new GitRunner({
      executable: this.options.gitExecutable,
      env: this.options.gitEnv,
      redact,
      timeoutMs: configNumber(c, 'timeoutMs') ?? 120_000,
    });
  }

  private get config(): ResolvedConfig {
    if (!this.cfg || !this.git || this.disposed) throw new SyncProviderError('UNAVAILABLE', 'Git provider is not initialized');
    return this.cfg;
  }

  private signal(options?: SyncOperationOptions): AbortSignal | undefined {
    const s = [options?.signal, this.context?.signal].filter((x): x is AbortSignal => !!x);
    return s.length > 1 ? AbortSignal.any(s) : s[0];
  }

  private run(args: string[], signal?: AbortSignal, extra: { allowFail?: boolean; env?: Record<string, string> } = {}): Promise<GitResult> {
    const cfg = this.config;
    throwIfCancelled(signal);
    return this.git!.run(args, { cwd: cfg.workTree, signal, allowFail: extra.allowFail, env: { ...this.authEnv, ...this.identityEnv, ...extra.env } });
  }

  private async out(args: string[], signal?: AbortSignal): Promise<string | null> {
    const r = await this.run(args, signal, { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  private ensureReady(signal?: AbortSignal): Promise<void> {
    if (!this.ready) {
      this.ready = this.prepareRepository(signal).catch((e) => {
        this.ready = undefined;
        throw e;
      });
    }
    return this.ready;
  }

  /** Clone / init the working copy, configure the remote and the commit identity. */
  private async prepareRepository(signal?: AbortSignal): Promise<void> {
    const cfg = this.config;
    const isRepo = await pathExists(path.join(cfg.workTree, '.git'));
    if (!isRepo) {
      await fs.mkdir(cfg.workTree, { recursive: true });
      const entries = await fs.readdir(cfg.workTree);
      if (cfg.remoteUrl && entries.length === 0) {
        this.context?.logger.info('git: cloning remote repository');
        await this.git!.run(['clone', '-q', '--origin', cfg.remoteName, '--', cfg.remoteUrl, cfg.workTree], {
          cwd: path.dirname(cfg.workTree),
          signal,
          env: this.authEnv,
        });
      } else {
        await this.run(['init', '-q'], signal);
      }
    }
    const gitDir = await this.out(['rev-parse', '--absolute-git-dir'], signal);
    if (!gitDir) throw new SyncProviderError('CONFIG', `${cfg.workTree} is not a usable Git working copy`);
    this.gitDir = gitDir;
    if (cfg.remoteUrl) {
      const existing = await this.out(['remote', 'get-url', cfg.remoteName], signal);
      if (existing === null) await this.run(['remote', 'add', cfg.remoteName, cfg.remoteUrl], signal);
      else if (existing !== cfg.remoteUrl && sanitizeGitOutput(existing) !== sanitizeGitOutput(cfg.remoteUrl)) {
        throw new SyncProviderError('CONFIG', `Remote "${cfg.remoteName}" of the repository points to a different URL`);
      }
    }
    const name = cfg.authorName ?? (await this.out(['config', 'user.name'], signal)) ?? '';
    const email = cfg.authorEmail ?? (await this.out(['config', 'user.email'], signal)) ?? '';
    const n = name || 'REQVYN Sync';
    const m = email || 'reqvyn-sync@localhost';
    this.identityEnv = { GIT_AUTHOR_NAME: n, GIT_AUTHOR_EMAIL: m, GIT_COMMITTER_NAME: n, GIT_COMMITTER_EMAIL: m };
  }

  private async hasRemote(signal?: AbortSignal): Promise<boolean> {
    const cfg = this.config;
    if (cfg.remoteUrl) return true;
    return (await this.out(['remote', 'get-url', cfg.remoteName], signal)) !== null;
  }

  private remoteRef(): string {
    return `refs/remotes/${this.config.remoteName}/${this.config.branch}`;
  }

  private withLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return FileLock.with(path.join(this.gitDir, 'reqvyn-sync.lock'), fn, { timeoutMs: this.options.lockTimeoutMs ?? 30_000, signal });
  }

  private rel(collectionId: string): string {
    const enc = encodeFileName(collectionId);
    return this.config.subdirectory ? `${this.config.subdirectory}/${enc}` : enc;
  }

  private abs(rel: string): string {
    return path.join(this.config.workTree, ...rel.split('/'));
  }

  // ------------------------------------------------------------------ repository state

  /** Fetch and fast-forward / rebase the configured branch. Returns whether a remote is in use. */
  private async update(signal?: AbortSignal): Promise<boolean> {
    const cfg = this.config;
    const remote = await this.hasRemote(signal);
    let remoteSha: string | null = null;
    if (remote) {
      const f = await this.run(['fetch', '-q', '--no-tags', cfg.remoteName, `+refs/heads/${cfg.branch}:${this.remoteRef()}`], signal, { allowFail: true });
      if (f.code === 0) remoteSha = await this.out(['rev-parse', '-q', '--verify', `${this.remoteRef()}^{commit}`], signal);
      else if (!/couldn't find remote ref/i.test(f.stderr)) throw this.git!.toError(['fetch'], f, 'NETWORK');
    }
    const head = await this.out(['symbolic-ref', '-q', 'HEAD'], signal);
    const headSha = await this.out(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], signal);
    if (head !== `refs/heads/${cfg.branch}`) {
      const localBranch = await this.out(['rev-parse', '-q', '--verify', `refs/heads/${cfg.branch}^{commit}`], signal);
      if (localBranch) await this.run(['checkout', '-q', cfg.branch], signal);
      else if (remoteSha) await this.run(['checkout', '-q', ...(headSha ? [] : ['-f']), '-B', cfg.branch, this.remoteRef()], signal);
      else if (!headSha) await this.run(['symbolic-ref', 'HEAD', `refs/heads/${cfg.branch}`], signal);
      else await this.run(['checkout', '-q', '-b', cfg.branch], signal);
    }
    if (!remoteSha) return remote;
    const local = await this.out(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], signal);
    if (!local) {
      await this.run(['checkout', '-q', '-f', '-B', cfg.branch, this.remoteRef()], signal);
    } else if (local !== remoteSha) {
      const behind = (await this.run(['merge-base', '--is-ancestor', local, remoteSha], signal, { allowFail: true })).code === 0;
      const ahead = !behind && (await this.run(['merge-base', '--is-ancestor', remoteSha, local], signal, { allowFail: true })).code === 0;
      if (behind) await this.run(['merge', '-q', '--ff-only', this.remoteRef()], signal);
      else if (!ahead) {
        const r = await this.run(['rebase', '-q', '--autostash', this.remoteRef()], signal, { allowFail: true });
        if (r.code !== 0) {
          await this.run(['rebase', '--abort'], signal, { allowFail: true });
          throw new SyncProviderError('CONFLICT', 'The local branch has diverged from the remote and cannot be rebased automatically', {
            retryable: false,
            details: { branch: cfg.branch },
          });
        }
      }
    }
    return remote;
  }

  /** Restore a collection directory to its committed state (crash recovery / undo). */
  private async restorePath(rel: string, signal?: AbortSignal): Promise<void> {
    const head = await this.out(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], signal);
    if (head) {
      await this.run(['reset', '-q', 'HEAD', '--', rel], signal, { allowFail: true });
      const inHead = (await this.run(['cat-file', '-e', `HEAD:${rel}`], signal, { allowFail: true })).code === 0;
      if (inHead) await this.run(['checkout', '-q', 'HEAD', '--', rel], signal);
      await this.run(['clean', '-fdq', '--', rel], signal, { allowFail: true });
      if (!inHead) await fs.rm(this.abs(rel), { recursive: true, force: true });
    } else {
      await this.run(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', rel], signal, { allowFail: true });
      await fs.rm(this.abs(rel), { recursive: true, force: true });
    }
    await cleanTempFiles(this.abs(rel));
  }

  /** SHA of the last commit touching the collection, or `null` if it does not exist. */
  private async pathRevision(rel: string, ref = 'HEAD', signal?: AbortSignal): Promise<string | null> {
    if (ref === 'HEAD' && !(await pathExists(path.join(this.abs(rel), MANIFEST_FILE)))) return null;
    if (ref !== 'HEAD' && (await this.run(['cat-file', '-e', `${ref}:${rel}/${MANIFEST_FILE}`], signal, { allowFail: true })).code !== 0) return null;
    const sha = await this.out(['log', '-1', '--format=%H', ref, '--', rel], signal);
    return sha || null;
  }

  private async prepare(collectionId: string, signal?: AbortSignal): Promise<string> {
    await this.ensureReady(signal);
    const rel = this.rel(collectionId);
    await this.restorePath(rel, signal);
    await this.update(signal);
    return rel;
  }

  private wrap<T>(fn: () => Promise<T>, message: string): Promise<T> {
    return fn().catch((e) => {
      throw toSyncProviderError(e, message);
    });
  }

  // ------------------------------------------------------------------ provider API

  getRemoteManifest(collectionId: string, options?: SyncOperationOptions): Promise<SyncManifest | null> {
    const signal = this.signal(options);
    return this.wrap(async () => {
      await this.ensureReady(signal);
      return this.withLock(async () => {
        const rel = await this.prepare(collectionId, signal);
        const m = await readManifest(this.abs(rel));
        if (!m) return null;
        const revision = await this.pathRevision(rel, 'HEAD', signal);
        return revision ? { ...m, revision } : null;
      }, signal);
    }, 'Could not read the Git repository');
  }

  pull(collectionId: string, options?: SyncOperationOptions): Promise<SyncSnapshot | null> {
    const signal = this.signal(options);
    options?.progress?.report({ phase: 'pull', message: 'Fetching Git repository', collectionId });
    return this.wrap(async () => {
      await this.ensureReady(signal);
      return this.withLock(async () => {
        const rel = await this.prepare(collectionId, signal);
        const revision = await this.pathRevision(rel, 'HEAD', signal);
        if (!revision) return null; // never committed (an uncommitted manifest was removed by restorePath)
        const snap = await readCollectionDir(this.abs(rel), collectionId);
        return snap ? { ...snap, revision } : null;
      }, signal);
    }, 'Could not read the Git repository');
  }

  async push(collectionId: string, snapshot: SyncSnapshot, expectedRevision?: string | null, options?: SyncOperationOptions): Promise<SyncPushResult> {
    if (snapshot.collectionId !== collectionId) throw new SyncProviderError('INVALID_DATA', 'Snapshot collection id mismatch');
    const signal = this.signal(options);
    options?.progress?.report({ phase: 'push', message: 'Committing and pushing', collectionId });
    const label = snapshot.label ? `${snapshot.label.replace(/[\r\n]+/g, ' ').slice(0, 120)} ` : '';
    return this.wrap(
      () =>
        this.commitChange(collectionId, expectedRevision, `REQVYN sync: update ${label}(${collectionId})`, signal, async (dir, rel) => {
          const current = await readManifest(dir).catch(() => null);
          if (current && current.revision === computeSnapshotRevision({ ...snapshot, revision: null })) return false;
          await writeCollectionDir(dir, snapshot, {
            stagingDir: path.join(this.gitDir, 'reqvyn-staging', encodeFileName(collectionId)),
            hooks: this.options.hooks,
          });
          await this.run(['add', '-A', '--', rel], signal);
          return true;
        }),
      'Could not push to the Git repository',
    );
  }

  async deleteRemoteCollection(collectionId: string, expectedRevision?: string | null, options?: SyncOperationOptions): Promise<void> {
    const signal = this.signal(options);
    const result = await this.wrap(
      () =>
        this.commitChange(collectionId, expectedRevision, `REQVYN sync: delete (${collectionId})`, signal, async (_dir, rel) => {
          const tracked = (await this.run(['ls-files', '--', rel], signal)).stdout.trim();
          if (!tracked) return false;
          await this.run(['rm', '-r', '-q', '--', rel], signal);
          return true;
        }),
      'Could not delete from the Git repository',
    );
    if (result.status === 'conflict') throw new SyncProviderError('CONFLICT', 'Remote collection changed; refusing to delete');
  }

  /**
   * Shared commit + push flow (under the working-copy lock): update, check the expected
   * revision, apply `mutate`, commit only the collection directory, push. Any push failure undoes
   * the local commit, so the working copy never holds unpushed sync commits.
   */
  private async commitChange(
    collectionId: string,
    expectedRevision: string | null | undefined,
    message: string,
    signal: AbortSignal | undefined,
    mutate: (dir: string, rel: string) => Promise<boolean>,
  ): Promise<SyncPushResult> {
    await this.ensureReady(signal);
    const retries = this.options.pushRaceRetries ?? 3;
    return this.withLock(async () => {
      for (let attempt = 0; ; attempt++) {
        const rel = await this.prepare(collectionId, signal);
        const remote = await this.hasRemote(signal);
        const current = await this.pathRevision(rel, 'HEAD', signal);
        if (expectedRevision !== undefined && current !== expectedRevision) {
          return { status: 'conflict', remoteRevision: current, message: 'The collection changed in the repository' };
        }
        const dir = this.abs(rel);
        let changed: boolean;
        try {
          changed = await mutate(dir, rel);
          if (changed) changed = (await this.run(['diff', '--cached', '--quiet', '--', rel], signal, { allowFail: true })).code === 1;
        } catch (e) {
          await this.restorePath(rel).catch(() => undefined);
          throw e;
        }
        if (!changed) {
          await this.restorePath(rel, signal);
          return { status: 'ok', revision: current ?? '' };
        }
        throwIfCancelled(signal);
        const parent = await this.out(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], signal);
        await this.run(['commit', '-q', '-m', message, '--', rel], signal);
        const sha = (await this.out(['rev-parse', 'HEAD'], signal)) ?? '';
        if (!remote) return { status: 'ok', revision: sha };
        // From here on the push must not be cancelled half-way: run it without the signal.
        const pushed = await this.run(['push', '-q', '--porcelain', this.config.remoteName, `HEAD:refs/heads/${this.config.branch}`], undefined, { allowFail: true });
        if (pushed.code === 0) {
          await this.run(['update-ref', this.remoteRef(), sha], undefined, { allowFail: true });
          return { status: 'ok', revision: sha };
        }
        await this.undoCommit(parent, rel);
        if (!isPushRejected(pushed)) throw this.git!.toError(['push'], pushed, 'NETWORK');
        this.context?.logger.debug('git: push rejected (remote moved), re-checking', { attempt });
        if (attempt >= retries) {
          await this.update(signal).catch(() => undefined);
          return { status: 'conflict', remoteRevision: await this.pathRevision(rel, this.remoteRef(), signal).catch(() => null), message: 'Push rejected by the remote' };
        }
      }
    }, signal);
  }

  private async undoCommit(parent: string | null, rel: string): Promise<void> {
    if (parent) await this.run(['reset', '-q', '--soft', parent], undefined);
    else await this.run(['update-ref', '-d', 'HEAD'], undefined);
    await this.restorePath(rel);
  }

  async testConnection(options?: SyncOperationOptions): Promise<SyncHealthResult> {
    const signal = this.signal(options);
    const started = Date.now();
    try {
      const cfg = this.config;
      const version = await this.git!.run(['--version'], { cwd: process.cwd(), signal });
      await this.ensureReady(signal);
      if (await this.hasRemote(signal)) {
        await this.run(['ls-remote', '--heads', cfg.remoteName], signal);
      }
      return { ok: true, message: `${version.stdout.trim()}; repository ${cfg.workTree} is usable`, latencyMs: Date.now() - started };
    } catch (e) {
      const err = toSyncProviderError(e, 'Git repository is not usable');
      return { ok: false, message: err.message, code: err.code, latencyMs: Date.now() - started };
    }
  }

  listRemoteCollections(options?: SyncOperationOptions): Promise<RemoteCollectionInfo[]> {
    const signal = this.signal(options);
    return this.wrap(async () => {
      await this.ensureReady(signal);
      return this.withLock(async () => {
        await this.update(signal);
        const base = this.config.subdirectory ? this.abs(this.config.subdirectory) : this.config.workTree;
        const names = await fs.readdir(base).catch(() => [] as string[]);
        const out: RemoteCollectionInfo[] = [];
        for (const n of names.sort()) {
          if (n.startsWith('.')) continue;
          const m = await readManifest(path.join(base, n)).catch(() => null);
          if (!m || encodeFileName(m.collectionId) !== n) continue;
          const revision = await this.pathRevision(this.rel(m.collectionId), 'HEAD', signal);
          if (revision) out.push({ collectionId: m.collectionId, label: m.label, revision, updatedAt: m.updatedAt });
        }
        return out;
      }, signal);
    }, 'Could not list the Git repository');
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

export function createGitProviderFactory(options: GitProviderOptions = {}): SyncProviderFactory {
  return { descriptor: gitDescriptor, create: () => new GitSyncProvider(options) };
}

export const gitProviderFactory: SyncProviderFactory = createGitProviderFactory();
