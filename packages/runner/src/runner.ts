import { mapConcurrent, sleep } from '@reqvyn/shared';
import {
  requestsInOrder,
  type Collection,
  type Environment,
  type ExecutionResult,
  type HttpRequest,
  type KeyValue,
  type RunnerProgress,
  type RunSummary,
} from '@reqvyn/core';
import type { DataRow } from './data.js';
import { executeRequest, type ExecutionOutcome, type ExecutorOptions } from './executor.js';
import { createVariableState, type VariableState } from './variables.js';

export interface RunOptions {
  collection: Collection;
  /** Run only this folder's subtree. */
  folderId?: string | null;
  /** Explicit selection (runs in collection order). */
  requestIds?: string[];
  /** Request ids to skip. */
  skip?: string[];
  iterations?: number;
  delayMs?: number;
  concurrency?: number;
  stopOnFailure?: boolean;
  /** Data rows; when given, one iteration runs per row. */
  data?: DataRow[];
  environment?: Environment | null;
  globals?: KeyValue[];
  workspace?: KeyValue[];
  state?: VariableState;
  signal?: AbortSignal;
  onProgress?: (p: RunnerProgress) => void;
  /** Called with the raw outcome (incl. unmasked variable changes) so hosts can persist them. */
  onResult?: (outcome: ExecutionOutcome, iteration: number) => void | Promise<void>;
  /** Response bodies larger than this are dropped from the report (default 256 KiB). */
  maxStoredBodyBytes?: number;
}

export type RunResultEntry = ExecutionResult & { iteration: number; durationMs: number; status: ResultStatus };
export type ResultStatus = 'passed' | 'failed' | 'errored' | 'skipped';

export interface RunReport {
  tool: { name: 'REQVYN'; version: string };
  collection: { id: string; name: string };
  folderId?: string | null;
  environment?: { id: string; name: string };
  iterations: number;
  summary: RunSummary;
  results: RunResultEntry[];
}

export const RUNNER_VERSION = '0.1.0';

export function classify(r: ExecutionResult): ResultStatus {
  if (r.skipped) return 'skipped';
  if (r.error) return 'errored';
  return r.tests.some((t) => !t.passed) ? 'failed' : 'passed';
}

export function selectRequests(o: Pick<RunOptions, 'collection' | 'folderId' | 'requestIds'>): HttpRequest[] {
  const ordered = requestsInOrder(o.collection, o.folderId ?? null);
  if (!o.requestIds?.length) return ordered;
  const wanted = new Set(o.requestIds);
  return ordered.filter((r) => wanted.has(r.id));
}

function slimResult(o: ExecutionOutcome, iteration: number, maxBody: number): RunResultEntry {
  const { rawVariableChanges: _raw, ...rest } = o;
  const entry: RunResultEntry = { ...rest, iteration, status: classify(o) };
  if (entry.response && entry.response.body.base64.length > (maxBody * 4) / 3) {
    entry.response = { ...entry.response, body: { ...entry.response.body, base64: '', truncated: true } };
  }
  return entry;
}

/** Run a collection (or folder/selection) and produce a report. Never throws for request failures. */
export async function runCollection(opts: RunOptions, exec: ExecutorOptions = {}): Promise<RunReport> {
  const startedAt = new Date();
  const c = opts.collection;
  const skip = new Set(opts.skip ?? []);
  const requests = selectRequests(opts);
  const iterations = opts.data?.length ? opts.data.length : Math.max(1, opts.iterations ?? c.runner.iterations ?? 1);
  const concurrency = Math.max(1, opts.concurrency ?? c.runner.concurrency ?? 1);
  const delayMs = Math.max(0, opts.delayMs ?? c.runner.delayMs ?? 0);
  const stopOnFailure = opts.stopOnFailure ?? c.runner.stopOnFailure ?? false;
  const maxBody = opts.maxStoredBodyBytes ?? 256 * 1024;
  const state = opts.state ?? createVariableState();
  const results: RunResultEntry[] = [];
  const total = requests.length * iterations;
  let completed = 0;
  let stop = false;
  const cancelled = () => opts.signal?.aborted ?? false;

  outer: for (let it = 1; it <= iterations; it++) {
    if (stop || cancelled()) break;
    const data = opts.data?.[it - 1];
    const runOne = async (req: HttpRequest, index: number): Promise<void> => {
      if (stop || cancelled()) return;
      if (skip.has(req.id)) {
        const entry: RunResultEntry = { requestId: req.id, requestName: req.name, tests: [], console: [], variableChanges: [], skipped: true, iteration: it, durationMs: 0, status: 'skipped' };
        results.push(entry);
        completed++;
        opts.onProgress?.({ iteration: it, totalIterations: iterations, completed, total, result: entry });
        return;
      }
      opts.onProgress?.({ iteration: it, totalIterations: iterations, completed, total, current: { requestId: req.id, name: req.name } });
      const outcome = await executeRequest(
        { collection: c, request: req, environment: opts.environment, globals: opts.globals, workspace: opts.workspace, data, state, signal: opts.signal },
        exec,
      );
      await opts.onResult?.(outcome, it);
      const entry = slimResult(outcome, it, maxBody);
      results.push(entry);
      completed++;
      opts.onProgress?.({ iteration: it, totalIterations: iterations, completed, total, result: entry });
      if (stopOnFailure && (entry.status === 'failed' || entry.status === 'errored')) stop = true;
      const isLast = it === iterations && index === requests.length - 1;
      if (delayMs > 0 && !isLast && !stop && !cancelled()) await sleep(delayMs, opts.signal).catch(() => undefined);
    };
    if (concurrency === 1) {
      for (let i = 0; i < requests.length; i++) {
        if (stop || cancelled()) break outer;
        await runOne(requests[i]!, i);
      }
    } else {
      await mapConcurrent(requests, concurrency, runOne);
    }
  }

  const finishedAt = new Date();
  const count = (s: ResultStatus) => results.filter((r) => r.status === s).length;
  const allTests = results.flatMap((r) => r.tests);
  return {
    tool: { name: 'REQVYN', version: RUNNER_VERSION },
    collection: { id: c.id, name: c.name },
    folderId: opts.folderId ?? null,
    environment: opts.environment ? { id: opts.environment.id, name: opts.environment.name } : undefined,
    iterations,
    summary: {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      total: results.length,
      passed: count('passed'),
      failed: count('failed'),
      skipped: count('skipped'),
      errored: count('errored'),
      assertions: { passed: allTests.filter((t) => t.passed).length, failed: allTests.filter((t) => !t.passed).length },
      cancelled: cancelled(),
    },
    results,
  };
}

/** True when the run had no failures, errors or cancellation (CLI exit code 0). */
export function runSucceeded(report: RunReport): boolean {
  const s = report.summary;
  return !s.cancelled && s.failed === 0 && s.errored === 0;
}
