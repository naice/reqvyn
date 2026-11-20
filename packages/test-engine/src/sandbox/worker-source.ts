import { BOOTSTRAP_SOURCE } from './bootstrap-source.js';

/**
 * Source of the worker thread (run with `new Worker(source, { eval: true })` so the bundled
 * extension/CLI never needs a separate file on disk). The worker:
 *   1. grabs `vm` and `worker_threads`, then strips loader capabilities from its own realm
 *      (defence in depth only — the vm context is the primary barrier, the worker + resource
 *      limits + parent-side termination are the containment);
 *   2. for every job creates a FRESH vm context with string/wasm code generation disabled;
 *   3. evaluates the bootstrap (context realm) and compiles the user code as an async function;
 *   4. streams console output and posts a single JSON string result.
 * Only primitive values / plain JSON cross the context and worker boundaries.
 *
 * NOTE: embedded as a string; avoid backticks and dollar-brace sequences.
 */
export const WORKER_SOURCE = String.raw`'use strict';
const wt = require('worker_threads');
const vm = require('vm');
const parentPort = wt.parentPort;
const BOOTSTRAP = ${JSON.stringify(BOOTSTRAP_SOURCE)};
const SCRIPT_FILE = 'reqvyn-script.js';

// ---- hardening of the worker realm (defence in depth) ----
try { process.on('unhandledRejection', function () {}); } catch (e) {}
for (const k of ['binding', '_linkedBinding', 'dlopen', 'getBuiltinModule', 'chdir', 'kill', 'setuid', 'setgid']) {
  try { Object.defineProperty(process, k, { value: undefined, configurable: false, writable: false }); } catch (e) {}
}
try { delete globalThis.require; } catch (e) {}
try { delete globalThis.module; } catch (e) {}
try { delete globalThis.exports; } catch (e) {}
try { delete globalThis.fetch; delete globalThis.WebSocket; delete globalThis.EventSource; } catch (e) {}
const _setTimeout = setTimeout;
const _setImmediate = setImmediate;

let current = null;

function lineFromSyntaxError(e) {
  try {
    const st = String(e && e.stack || '');
    const m = /reqvyn-script\.js:(\d+)/.exec(st);
    if (m) return Math.max(1, Number(m[1]));
  } catch (x) {}
  return undefined;
}

function runJob(job) {
  const jobId = job.jobId;
  const state = { finished: false, consoleBytes: 0, consoleEntries: 0, truncatedNotified: false };
  current = state;
  const maxBytes = job.maxConsoleBytes;
  const maxEntries = job.maxConsoleEntries;

  const hostLog = function (level, message) {
    if (state.finished) return;
    if (typeof message !== 'string') return;
    const lvl = level === 'info' || level === 'warn' || level === 'error' ? level : 'log';
    if (state.consoleBytes + message.length > maxBytes || state.consoleEntries >= maxEntries) {
      if (!state.truncatedNotified) {
        state.truncatedNotified = true;
        parentPort.postMessage({ type: 'console', jobId: jobId, level: 'warn', message: '[console output truncated: limit reached]', at: Date.now() });
      }
      return;
    }
    state.consoleBytes += message.length;
    state.consoleEntries++;
    parentPort.postMessage({ type: 'console', jobId: jobId, level: lvl, message: message, at: Date.now() });
  };
  const hostTimer = function (ms, cb) {
    if (state.finished) return;
    const n = Number(ms);
    _setTimeout(function () {
      if (state.finished) return;
      try { cb(); } catch (e) {}
    }, n > 0 && n <= 2000 ? n : (n > 2000 ? 2000 : 0));
  };
  const hostDone = function (json) {
    if (state.finished) return;
    state.finished = true;
    parentPort.postMessage({ type: 'done', jobId: jobId, result: typeof json === 'string' ? json : null });
    // Signal that the event loop is free again (a runaway microtask loop would starve this).
    _setImmediate(function () { parentPort.postMessage({ type: 'idle', jobId: jobId }); });
  };

  let init;
  let ctx;
  try {
    ctx = vm.createContext(Object.create(null), {
      name: 'reqvyn-script',
      codeGeneration: { strings: false, wasm: false }
    });
    init = new vm.Script(BOOTSTRAP, { filename: 'reqvyn-bootstrap.js' }).runInContext(ctx);
  } catch (e) {
    hostDone(JSON.stringify({ error: { message: 'Script sandbox failed to start: ' + (e && e.message) } }));
    return;
  }

  let userFn = null;
  let compileError = null;
  try {
    userFn = new vm.Script('(async function () {\n' + String(job.code) + '\n})', { filename: SCRIPT_FILE, lineOffset: -1 }).runInContext(ctx, { timeout: job.timeoutMs });
  } catch (e) {
    const line = lineFromSyntaxError(e);
    compileError = { message: (e && e.name ? e.name + ': ' : '') + String(e && e.message || e) };
    if (line !== undefined) compileError.line = line;
  }
  try {
    init(job.inputJson, hostLog, hostTimer, hostDone, userFn, compileError);
  } catch (e) {
    hostDone(JSON.stringify({ error: { message: 'Script failed: ' + String(e && e.message || e) } }));
  }
}

parentPort.on('message', function (msg) {
  if (!msg || msg.type !== 'run' || !msg.job) return;
  if (current && !current.finished) current.finished = true;
  runJob(msg.job);
});
parentPort.postMessage({ type: 'ready' });
`;
