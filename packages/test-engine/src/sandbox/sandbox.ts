import { Worker } from 'node:worker_threads';
import { VARIABLE_SCOPES, type ConsoleEntry, type Cookie, type TestResult, type WritableVariableScope } from '@reqvyn/core';
import { redactSecrets } from '@reqvyn/shared';
import type { ResponseContext } from '../context.js';
import { WORKER_SOURCE } from './worker-source.js';

export interface ScriptRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: string;
}

export interface ScriptRunOptions {
  code: string;
  phase: 'pre' | 'post';
  request: ScriptRequest;
  response?: ResponseContext;
  /** Resolved variable snapshot visible to scripts (`reqvyn.variables.get`). */
  variables: Record<string, string>;
  /** Per-scope values backing `reqvyn.env` / `collectionVariables` / `globals` (fall back to `variables`). */
  scopes?: Partial<Record<WritableVariableScope, Record<string, string>>>;
  /** Wall-clock limit enforced by terminating the worker. Default 5000 ms. */
  timeoutMs?: number;
  /** V8 old-generation heap limit for the worker. Default 64 MB. */
  memoryLimitMb?: number;
  signal?: AbortSignal;
  /** Values redacted from console output, test names/messages and error messages. */
  secrets?: string[];
  /** Total console characters kept (default 256 KiB). */
  maxConsoleBytes?: number;
  /** Maximum number of console entries kept (default 1000). */
  maxConsoleEntries?: number;
}

export interface ScriptVariableChange {
  scope: WritableVariableScope;
  key: string;
  /** `null` means the variable was unset. */
  value: string | null;
}

export interface ScriptRunResult {
  request: ScriptRequest;
  variableChanges: ScriptVariableChange[];
  tests: TestResult[];
  console: ConsoleEntry[];
  error?: { message: string; line?: number };
  skipRequest?: boolean;
  durationMs: number;
  /** Set when the run was stopped because it exceeded `timeoutMs`. */
  timedOut?: boolean;
  /** Set when the run was cancelled through the AbortSignal. */
  cancelled?: boolean;
}

export const DEFAULT_SCRIPT_TIMEOUT_MS = 5000;
export const DEFAULT_SCRIPT_MEMORY_MB = 64;
const DEFAULT_CONSOLE_BYTES = 256 * 1024;
const DEFAULT_CONSOLE_ENTRIES = 1000;
const BOOT_TIMEOUT_MS = 15000;
const IDLE_GRACE_MS = 250;
const MAX_CODE_LENGTH = 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Worker handle
// ---------------------------------------------------------------------------------------------

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'console'; jobId: number; level: string; message: string; at: number }
  | { type: 'done'; jobId: number; result: string | null }
  | { type: 'idle'; jobId: number };

type JobOutcome =
  | { kind: 'done'; json: string | null }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'crash'; message: string };

let jobSeq = 0;

class SandboxWorker {
  readonly worker: Worker;
  readonly ready: Promise<void>;
  dead = false;
  jobs = 0;
  private exitError?: string;
  private listeners = new Set<(m: WorkerMessage) => void>();
  private deathListeners = new Set<(message: string) => void>();

  constructor(readonly memoryLimitMb: number) {
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      env: {},
      argv: [],
      execArgv: [],
      stdout: true,
      stderr: true,
      name: 'reqvyn-script-sandbox',
      resourceLimits: {
        maxOldGenerationSizeMb: memoryLimitMb,
        maxYoungGenerationSizeMb: Math.max(2, Math.min(16, Math.floor(memoryLimitMb / 4))),
        codeRangeSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    this.worker.stdout?.resume();
    this.worker.stderr?.resume();
    this.worker.unref();
    this.ready = new Promise<void>((resolve, reject) => {
      const onMsg = (m: WorkerMessage) => {
        if (m && m.type === 'ready') {
          this.listeners.delete(onMsg);
          resolve();
        }
      };
      this.listeners.add(onMsg);
      this.deathListeners.add((message) => reject(new Error(message)));
    });
    this.ready.catch(() => undefined);
    this.worker.on('message', (m: WorkerMessage) => {
      for (const l of [...this.listeners]) l(m);
    });
    this.worker.on('error', (err: Error & { code?: string }) => {
      this.exitError =
        err.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? `Script exceeded the memory limit of ${this.memoryLimitMb} MB`
          : `Script worker crashed: ${err.message}`;
    });
    this.worker.on('exit', (code) => {
      this.dead = true;
      const message = this.exitError ?? `Script worker exited unexpectedly (code ${code})`;
      for (const l of [...this.deathListeners]) l(message);
      this.deathListeners.clear();
      this.listeners.clear();
    });
  }

  onMessage(l: (m: WorkerMessage) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onDeath(l: (message: string) => void): () => void {
    if (this.dead) {
      l(this.exitError ?? 'Script worker is not running');
      return () => undefined;
    }
    this.deathListeners.add(l);
    return () => this.deathListeners.delete(l);
  }

  terminate(reason?: string): Promise<void> {
    if (reason && !this.exitError) this.exitError = reason;
    if (this.dead) return Promise.resolve();
    this.dead = true;
    return this.worker.terminate().then(
      () => undefined,
      () => undefined,
    );
  }
}

interface JobRun {
  outcome: JobOutcome;
  console: ConsoleEntry[];
  /** Resolves true once the worker is idle again and may be reused. */
  reusable: Promise<boolean>;
}

function abortError(): JobOutcome {
  return { kind: 'cancelled' };
}

async function runOnWorker(w: SandboxWorker, opts: ScriptRunOptions, timeoutMs: number): Promise<JobRun> {
  const consoleEntries: ConsoleEntry[] = [];
  const signal = opts.signal;
  if (signal?.aborted) {
    void w.terminate();
    return { outcome: abortError(), console: consoleEntries, reusable: Promise.resolve(false) };
  }

  // Wait for boot (pooled workers are already ready).
  const bootOutcome = await new Promise<JobOutcome | undefined>((resolve) => {
    const onAbort = () => done(abortError());
    const done = (o: JobOutcome | undefined) => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      resolve(o);
    };
    const t = setTimeout(() => done({ kind: 'crash', message: 'Script sandbox did not start in time' }), BOOT_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    w.ready.then(
      () => done(undefined),
      (e: Error) => done({ kind: 'crash', message: e.message }),
    );
  });
  if (bootOutcome) {
    void w.terminate();
    return { outcome: bootOutcome, console: consoleEntries, reusable: Promise.resolve(false) };
  }

  const jobId = ++jobSeq;
  let resolveReusable!: (v: boolean) => void;
  const reusable = new Promise<boolean>((r) => (resolveReusable = r));

  const outcome = await new Promise<JobOutcome>((resolve) => {
    let settled = false;
    const finish = (o: JobOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      offDeath();
      if (o.kind !== 'done') {
        offMsg();
        void w.terminate();
        resolveReusable(false);
      }
      resolve(o);
    };
    const offMsg = w.onMessage((m) => {
      if (!m || (m as { jobId?: number }).jobId !== jobId) return;
      if (m.type === 'console') {
        consoleEntries.push({
          level: m.level === 'info' || m.level === 'warn' || m.level === 'error' ? m.level : 'log',
          message: typeof m.message === 'string' ? m.message : String(m.message),
          at: typeof m.at === 'number' ? m.at : Date.now(),
        });
      } else if (m.type === 'done') {
        finish({ kind: 'done', json: typeof m.result === 'string' ? m.result : null });
        const graceTimer = setTimeout(() => {
          offMsg();
          resolveReusable(false);
        }, IDLE_GRACE_MS);
        const offIdle = w.onMessage((m2) => {
          if (m2 && m2.type === 'idle' && m2.jobId === jobId) {
            clearTimeout(graceTimer);
            offIdle();
            offMsg();
            resolveReusable(!w.dead);
          }
        });
      }
    });
    const offDeath = w.onDeath((message) => finish({ kind: 'crash', message }));
    const onAbort = () => finish(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);

    const input = {
      phase: opts.phase,
      request: opts.request,
      response: opts.response,
      variables: opts.variables ?? {},
      scopes: opts.scopes ?? {},
    };
    try {
      w.jobs++;
      w.worker.postMessage({
        type: 'run',
        job: {
          jobId,
          code: opts.code,
          inputJson: JSON.stringify(input),
          timeoutMs,
          maxConsoleBytes: opts.maxConsoleBytes ?? DEFAULT_CONSOLE_BYTES,
          maxConsoleEntries: opts.maxConsoleEntries ?? DEFAULT_CONSOLE_ENTRIES,
        },
      });
    } catch (e) {
      finish({ kind: 'crash', message: `Could not start script: ${(e as Error).message}` });
    }
  });
  return { outcome, console: consoleEntries, reusable };
}

// ---------------------------------------------------------------------------------------------
// Result sanitisation (never trust data coming back from the worker)
// ---------------------------------------------------------------------------------------------

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function sanitizeHeaders(v: unknown, fallback: Array<[string, string]>): Array<[string, string]> {
  if (!Array.isArray(v)) return fallback;
  const out: Array<[string, string]> = [];
  for (const h of v) if (Array.isArray(h) && h.length === 2 && isStr(h[0]) && isStr(h[1])) out.push([h[0], h[1]]);
  return out;
}

function sanitizeRequest(v: unknown, original: ScriptRequest): ScriptRequest {
  if (typeof v !== 'object' || v === null) return original;
  const r = v as Record<string, unknown>;
  const out: ScriptRequest = {
    method: isStr(r.method) && r.method ? r.method : original.method,
    url: isStr(r.url) ? r.url : original.url,
    headers: sanitizeHeaders(r.headers, original.headers),
  };
  if (isStr(r.body)) out.body = r.body;
  return out;
}

function cloneRequest(r: ScriptRequest): ScriptRequest {
  const out: ScriptRequest = { method: r.method, url: r.url, headers: r.headers.map(([k, v]) => [k, v] as [string, string]) };
  if (r.body !== undefined) out.body = r.body;
  return out;
}

function makeResult(
  opts: ScriptRunOptions,
  outcome: JobOutcome,
  consoleEntries: ConsoleEntry[],
  startedAt: number,
  timeoutMs: number,
): ScriptRunResult {
  const secrets = (opts.secrets ?? []).filter((s) => typeof s === 'string' && s.length > 0);
  const redact = (s: string) => (secrets.length ? redactSecrets(s, secrets) : s);
  const result: ScriptRunResult = {
    request: cloneRequest(opts.request),
    variableChanges: [],
    tests: [],
    console: consoleEntries.map((c) => ({ ...c, message: redact(c.message) })),
    durationMs: Date.now() - startedAt,
  };
  const prefix = opts.phase === 'pre' ? 'pre' : 'post';

  if (outcome.kind === 'timeout') {
    result.timedOut = true;
    result.error = { message: `Script timed out after ${timeoutMs} ms (it was terminated)` };
    return result;
  }
  if (outcome.kind === 'cancelled') {
    result.cancelled = true;
    result.error = { message: 'Script execution was cancelled' };
    return result;
  }
  if (outcome.kind === 'crash') {
    result.error = { message: redact(outcome.message) };
    return result;
  }
  let parsed: Record<string, unknown>;
  try {
    const p: unknown = outcome.json === null ? null : JSON.parse(outcome.json);
    if (typeof p !== 'object' || p === null) throw new Error('empty result');
    parsed = p as Record<string, unknown>;
  } catch {
    result.error = { message: 'Script produced an invalid result' };
    return result;
  }

  if (opts.phase === 'pre') result.request = sanitizeRequest(parsed.request, result.request);
  if (Array.isArray(parsed.variableChanges)) {
    for (const c of parsed.variableChanges as unknown[]) {
      if (typeof c !== 'object' || c === null) continue;
      const { scope, key, value } = c as Record<string, unknown>;
      if (!(VARIABLE_SCOPES as readonly unknown[]).includes(scope) || !isStr(key) || key === '') continue;
      if (value !== null && !isStr(value)) continue;
      result.variableChanges.push({ scope: scope as WritableVariableScope, key, value: value as string | null });
    }
  }
  if (Array.isArray(parsed.tests)) {
    (parsed.tests as unknown[]).forEach((t, i) => {
      if (typeof t !== 'object' || t === null) return;
      const { name, passed, message } = t as Record<string, unknown>;
      const tr: TestResult = {
        id: `script:${prefix}:${i}`,
        name: redact(isStr(name) ? name : `Test ${i + 1}`),
        passed: passed === true,
        source: 'script',
      };
      if (isStr(message)) tr.message = redact(message);
      result.tests.push(tr);
    });
  }
  if (parsed.skipRequest === true && opts.phase === 'pre') result.skipRequest = true;
  if (typeof parsed.error === 'object' && parsed.error !== null) {
    const e = parsed.error as Record<string, unknown>;
    result.error = { message: redact(isStr(e.message) ? e.message : 'Script error') };
    if (typeof e.line === 'number' && Number.isInteger(e.line) && e.line > 0) result.error.line = e.line;
  }
  return result;
}

function normalizeResponse(r: ResponseContext | undefined): ResponseContext | undefined {
  if (!r) return undefined;
  return {
    status: Number(r.status) || 0,
    statusText: String(r.statusText ?? ''),
    headers: (r.headers ?? []).map(([k, v]) => [String(k), String(v)] as [string, string]),
    bodyText: String(r.bodyText ?? ''),
    timeMs: Number(r.timeMs) || 0,
    size: Number(r.size) || 0,
    cookies: (r.cookies ?? []).map((c: Cookie) => ({ ...c })),
    contentType: String(r.contentType ?? ''),
  };
}

function validateOptions(opts: ScriptRunOptions): { timeoutMs: number; memoryLimitMb: number; error?: string } {
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS));
  const memoryLimitMb = Math.max(8, Math.floor(opts.memoryLimitMb ?? DEFAULT_SCRIPT_MEMORY_MB));
  if (typeof opts.code !== 'string') return { timeoutMs, memoryLimitMb, error: 'Script code must be a string' };
  if (opts.code.length > MAX_CODE_LENGTH) return { timeoutMs, memoryLimitMb, error: 'Script is too large (max 1 MiB)' };
  return { timeoutMs, memoryLimitMb };
}

async function execute(opts: ScriptRunOptions, acquire: (mem: number) => SandboxWorker, release: (w: SandboxWorker, reusable: Promise<boolean>) => void): Promise<ScriptRunResult> {
  const startedAt = Date.now();
  const { timeoutMs, memoryLimitMb, error } = validateOptions(opts);
  const normalized: ScriptRunOptions = { ...opts, response: normalizeResponse(opts.response) };
  if (error) return makeResult(normalized, { kind: 'crash', message: error }, [], startedAt, timeoutMs);
  if (!opts.code.trim()) {
    return makeResult(normalized, { kind: 'done', json: JSON.stringify({ request: opts.request, variableChanges: [], tests: [] }) }, [], startedAt, timeoutMs);
  }
  if (opts.signal?.aborted) return makeResult(normalized, { kind: 'cancelled' }, [], startedAt, timeoutMs);
  let w: SandboxWorker;
  try {
    w = acquire(memoryLimitMb);
  } catch (e) {
    return makeResult(normalized, { kind: 'crash', message: `Could not start script sandbox: ${(e as Error).message}` }, [], startedAt, timeoutMs);
  }
  const run = await runOnWorker(w, normalized, timeoutMs);
  release(w, run.reusable);
  return makeResult(normalized, run.outcome, run.console, startedAt, timeoutMs);
}

/**
 * Run a pre-request or post-response script in a fresh, isolated worker thread. The returned promise
 * never rejects: syntax/runtime errors, timeouts, cancellation and resource exhaustion are reported
 * through `result.error`.
 */
export function runScript(opts: ScriptRunOptions): Promise<ScriptRunResult> {
  return execute(
    opts,
    (mem) => new SandboxWorker(mem),
    (w) => void w.terminate(),
  );
}

export interface ScriptSandboxPoolOptions {
  /** Maximum number of idle workers kept warm. Default 2. */
  size?: number;
  /** Memory limit of pooled workers. Runs requesting a different limit use a dedicated worker. Default 64. */
  memoryLimitMb?: number;
  /** Recycle a worker after this many jobs. Default 200. */
  maxJobsPerWorker?: number;
}

/**
 * Reuses warm workers across script runs (e.g. in the collection runner). Every run still gets a
 * fresh vm context; a worker is only reused after it reported an idle event loop, and is discarded
 * after any timeout, cancellation or crash.
 */
export class ScriptSandboxPool {
  private readonly idle: SandboxWorker[] = [];
  private readonly busy = new Set<SandboxWorker>();
  private disposed = false;
  private readonly size: number;
  private readonly memoryLimitMb: number;
  private readonly maxJobs: number;

  constructor(options: ScriptSandboxPoolOptions = {}) {
    this.size = Math.max(0, options.size ?? 2);
    this.memoryLimitMb = Math.max(8, options.memoryLimitMb ?? DEFAULT_SCRIPT_MEMORY_MB);
    this.maxJobs = Math.max(1, options.maxJobsPerWorker ?? 200);
  }

  /** Start idle workers ahead of time. */
  async warmup(count = this.size): Promise<void> {
    const started: SandboxWorker[] = [];
    while (!this.disposed && this.idle.length + started.length < Math.min(count, this.size)) started.push(new SandboxWorker(this.memoryLimitMb));
    await Promise.all(started.map((w) => w.ready.catch(() => undefined)));
    for (const w of started) {
      if (!w.dead && !this.disposed) this.idle.push(w);
      else void w.terminate();
    }
  }

  get idleCount(): number {
    return this.idle.length;
  }

  run(opts: ScriptRunOptions): Promise<ScriptRunResult> {
    if (this.disposed) {
      return Promise.resolve(
        makeResult(opts, { kind: 'crash', message: 'Script sandbox pool has been disposed' }, [], Date.now(), opts.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS),
      );
    }
    return execute(
      { ...opts, memoryLimitMb: opts.memoryLimitMb ?? this.memoryLimitMb },
      (mem) => {
        let w: SandboxWorker | undefined;
        if (mem === this.memoryLimitMb) {
          while ((w = this.idle.pop()) && w.dead);
        }
        if (!w || w.dead) w = new SandboxWorker(mem);
        this.busy.add(w);
        return w;
      },
      (w, reusable) => {
        void reusable.then((ok) => {
          this.busy.delete(w);
          if (ok && !this.disposed && !w.dead && w.memoryLimitMb === this.memoryLimitMb && w.jobs < this.maxJobs && this.idle.length < this.size) {
            this.idle.push(w);
          } else {
            void w.terminate();
          }
        });
      },
    );
  }

  /** Terminate all workers. Running scripts are terminated and report a crash/cancel error. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const all = [...this.idle, ...this.busy];
    this.idle.length = 0;
    this.busy.clear();
    await Promise.all(all.map((w) => w.terminate('Script sandbox pool was disposed')));
  }
}
