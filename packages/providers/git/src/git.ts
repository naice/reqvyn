import { execFile } from 'node:child_process';
import { SyncProviderError, type SyncProviderErrorCode } from '@reqvyn/provider-sdk';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunnerOptions {
  /** Git executable (default `git`, resolved through PATH). */
  executable?: string;
  /** Extra environment (merged over `process.env`). */
  env?: Record<string, string | undefined>;
  /** Strings that must never appear in errors / logs (tokens). */
  redact?: string[];
  /** Per-command timeout (default 120 s). */
  timeoutMs?: number;
}

export interface GitRunOptions {
  cwd: string;
  /** Resolve with the exit code instead of throwing on non-zero exit. */
  allowFail?: boolean;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

/** Environment variables that would redirect git to another repository. */
const SCRUBBED_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE', 'GIT_PREFIX'];

/** Remove credentials embedded in URLs and any configured secret from a message. */
export function sanitizeGitOutput(text: string, redact: readonly string[] = []): string {
  let out = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@');
  for (const r of redact) if (r) out = out.split(r).join('***');
  return out;
}

/**
 * Runs the git CLI through `execFile` (no shell, so arguments are never interpreted). The
 * environment forces non-interactive, English (`LC_ALL=C`) output so failures can be classified.
 */
export class GitRunner {
  readonly executable: string;
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly redact: string[];
  private readonly timeoutMs: number;

  constructor(options: GitRunnerOptions = {}) {
    this.executable = options.executable ?? 'git';
    this.redact = (options.redact ?? []).filter(Boolean);
    this.timeoutMs = options.timeoutMs ?? 120_000;
    const env: Record<string, string | undefined> = { ...process.env, ...options.env };
    for (const k of SCRUBBED_ENV) delete env[k];
    Object.assign(env, { LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' });
    this.baseEnv = env;
  }

  run(args: string[], options: GitRunOptions): Promise<GitResult> {
    const env = options.env ? { ...this.baseEnv, ...options.env } : this.baseEnv;
    return new Promise((resolve, reject) => {
      execFile(
        this.executable,
        args,
        { cwd: options.cwd, env: env as NodeJS.ProcessEnv, signal: options.signal, timeout: this.timeoutMs, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (!error) return resolve({ code: 0, stdout, stderr });
          const e = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
          if (e.name === 'AbortError' || options.signal?.aborted) {
            return reject(new SyncProviderError('CANCELLED', 'Git operation cancelled', { cause: undefined }));
          }
          if (typeof e.code === 'string') {
            if (e.code === 'ENOENT') {
              return reject(new SyncProviderError('CONFIG', 'Git executable not found (install git or configure its path)', { details: { executable: this.executable } }));
            }
            return reject(new SyncProviderError('INTERNAL', `Could not run git: ${e.code}`));
          }
          if (e.killed) {
            return reject(new SyncProviderError('NETWORK', `git ${args[0]} timed out after ${this.timeoutMs} ms`, { retryable: true }));
          }
          const result: GitResult = { code: typeof e.code === 'number' ? e.code : 1, stdout, stderr };
          if (options.allowFail) return resolve(result);
          reject(this.toError(args, result));
        },
      );
    });
  }

  /** Classify a failed git invocation. Output is sanitized (no URLs with credentials, no tokens). */
  toError(args: string[], result: GitResult, fallback: SyncProviderErrorCode = 'INTERNAL'): SyncProviderError {
    const text = `${result.stderr}\n${result.stdout}`;
    const first = sanitizeGitOutput(
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !/^hint:/i.test(l))
        .slice(0, 3)
        .join(' | '),
      this.redact,
    );
    const code = classifyGitFailure(text) ?? fallback;
    return new SyncProviderError(code, `git ${args[0]} failed (exit ${result.code})${first ? `: ${first}` : ''}`, {
      details: { command: args[0], exitCode: result.code },
    });
  }
}

export function classifyGitFailure(text: string): SyncProviderErrorCode | undefined {
  if (/\b403\b|permission to .* denied|access denied|forbidden/i.test(text)) return 'PERMISSION';
  if (/authentication failed|could not read (username|password)|permission denied \(publickey|\b401\b|invalid credentials|terminal prompts disabled/i.test(text)) return 'AUTH';
  if (/repository not found|does not appear to be a git repository|not a git repository|no such remote|refusing to update checked out branch/i.test(text)) return 'CONFIG';
  if (/could not resolve host|connection (refused|reset|timed out)|timed out|unable to access|could not read from remote repository|early eof|the remote end hung up|network is unreachable|failed to connect|\b50[234]\b/i.test(text)) return 'NETWORK';
  if (/index\.lock|unable to create .*\.lock|another git process/i.test(text)) return 'UNAVAILABLE';
  return undefined;
}

/** True if `git push` output indicates a rejected (non-fast-forward / stale) update. */
export function isPushRejected(result: GitResult): boolean {
  return /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|stale info|updates were rejected/i.test(`${result.stdout}\n${result.stderr}`) && !/\[remote rejected\].*(hook|denied|permission)/i.test(`${result.stdout}\n${result.stderr}`);
}
