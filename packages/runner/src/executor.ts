import { ReqvynError, REDACTED, redactSecrets, toErrorJson, errorMessage } from '@reqvyn/shared';
import {
  decodeBase64Text,
  resolveEffectiveConfig,
  type Collection,
  type ConsoleEntry,
  type EffectiveRequestConfig,
  type ExecutionResult,
  type HttpRequest,
  type HttpResponseData,
  type SecretVault,
  type TestResult,
  type TimelineEvent,
  type WritableVariableScope,
} from '@reqvyn/core';
import { NodeHttpTransport, buildUrl, type HttpTransport, type SendOptions, type PreparedBody } from '@reqvyn/http-engine';
import { applyAuth, answerChallenge, type ConcreteAuth, type InteractiveHooks, type TokenStore } from '@reqvyn/auth-engine';
import {
  evaluateAssertions,
  runExtractions,
  runScript,
  type ResponseContext,
  type ScriptRequest,
  type ScriptRunOptions,
  type ScriptRunResult,
  type ScriptSandboxPool,
} from '@reqvyn/test-engine';
import type { VariableContext } from '@reqvyn/environment-engine';
import { bodyTextForScript, defaultContentType, prepareBody } from './body.js';
import { applyVariableChange, buildVariableContext, createVariableState, scopeValues, type VariableSources, type VariableState } from './variables.js';

export interface ScriptSettings {
  /** Scripts only run when enabled (the extension disables them in untrusted workspaces). */
  enabled: boolean;
  timeoutMs?: number;
  memoryLimitMb?: number;
}

export interface ExecutorOptions {
  transport?: HttpTransport;
  vault?: SecretVault;
  tokenStore?: TokenStore;
  /** Browser/device-code hooks for OAuth 2.0. Absent in CI. */
  interactive?: InteractiveHooks;
  /** Defaults applied to every request: proxy, extra CA certificates, cookie jar, limits, User-Agent. */
  send?: SendOptions;
  /** Pooled sandbox; when absent every script runs in a fresh worker. */
  sandbox?: ScriptSandboxPool;
  scripts?: ScriptSettings;
  /** Directory used to resolve relative file paths (bodies, certificates). */
  baseDir?: string;
  processEnv?: Record<string, string | undefined>;
}

export interface ExecuteInput extends Omit<VariableSources, 'vault' | 'processEnv' | 'state'> {
  state?: VariableState;
  signal?: AbortSignal;
  /** Stream the response body to this file. */
  downloadPath?: string;
  onChunk?: (chunk: Buffer) => void;
}

export interface ExecutionOutcome extends ExecutionResult {
  durationMs: number;
  /** Raw (unmasked) variable changes for the host to persist. Never send these to a webview. */
  rawVariableChanges: Array<{ scope: WritableVariableScope; key: string; value: string | null }>;
}

function standaloneConfig(request: HttpRequest): EffectiveRequestConfig {
  return {
    headers: request.headers.filter((h) => h.enabled && h.key),
    auth: request.auth.type === 'inherit' ? { type: 'none' } : request.auth,
    authSource: { level: 'request', id: request.id, name: request.name },
    settings: request.settings,
    scripts: [{ level: 'request', name: request.name, scripts: request.scripts }],
    tests: [{ level: 'request', name: request.name, group: request.tests }],
    variableLayers: [{ level: 'request', name: request.name, variables: request.variables }],
  };
}

/** URL shown to scripts: raw URL plus enabled params (templates unresolved). */
function scriptUrl(request: HttpRequest): string {
  const params = request.params.filter((p) => p.enabled && p.key);
  if (!params.length) return request.url;
  const q = params.map((p) => `${p.key}=${p.value}`).join('&');
  return request.url + (request.url.includes('?') ? '&' : '?') + q;
}

function hasHeader(headers: Array<[string, string]>, name: string): boolean {
  const l = name.toLowerCase();
  return headers.some(([k]) => k.toLowerCase() === l);
}

/**
 * Executes a single request end-to-end: variables → pre-request scripts → resolution → auth →
 * HTTP → extractions → post-response scripts → assertions. Never throws; failures are reported
 * in `error` (and the response is kept when it was received).
 */
export async function executeRequest(input: ExecuteInput, opts: ExecutorOptions = {}): Promise<ExecutionOutcome> {
  const started = Date.now();
  const { request } = input;
  const state = input.state ?? createVariableState();
  const sources: VariableSources = { ...input, state, vault: opts.vault, processEnv: opts.processEnv };
  const out: ExecutionOutcome = {
    requestId: request.id,
    requestName: request.name,
    tests: [],
    console: [],
    variableChanges: [],
    rawVariableChanges: [],
    durationMs: 0,
  };
  const timeline: TimelineEvent[] = [];
  const note = (type: TimelineEvent['type'], message: string) => timeline.push({ at: Date.now(), type, message });
  let ctx: VariableContext | undefined;
  const secrets = () => ctx?.secretValues() ?? [];
  const redact = (s: string) => redactSecrets(s, secrets());

  const record = (scope: WritableVariableScope, key: string, value: string | null) => {
    if (!ctx || !key) return;
    const wasSecret = ctx.lookup(key)?.secret ?? false;
    applyVariableChange(ctx, state, scope, key, value);
    out.rawVariableChanges.push({ scope, key, value });
    out.variableChanges.push({ scope, key, value: value === null ? '' : wasSecret ? REDACTED : redact(value) });
  };

  const scriptsEnabled = opts.scripts?.enabled !== false;
  const runUserScript = (so: ScriptRunOptions): Promise<ScriptRunResult> => (opts.sandbox ? opts.sandbox.run(so) : runScript(so));
  const scriptOptions = (code: string, phase: 'pre' | 'post', req: ScriptRequest, response?: ResponseContext): ScriptRunOptions => ({
    code,
    phase,
    request: req,
    response,
    variables: safeSnapshot(ctx!),
    scopes: {
      environment: scopeValues(ctx!, 'environment', sources),
      collection: scopeValues(ctx!, 'collection', sources),
      global: scopeValues(ctx!, 'global', sources),
      runtime: Object.fromEntries(state.runtime),
    },
    timeoutMs: opts.scripts?.timeoutMs,
    memoryLimitMb: opts.scripts?.memoryLimitMb,
    signal: input.signal,
    secrets: secrets(),
  });
  const absorb = (r: ScriptRunResult, label: string) => {
    out.console.push(...r.console.map((c): ConsoleEntry => ({ ...c, message: redact(c.message) })));
    out.tests.push(...r.tests.map((t) => ({ ...t, name: redact(t.name), message: t.message && redact(t.message) })));
    for (const ch of r.variableChanges) record(ch.scope, ch.key, ch.value);
    note('script', `${label} finished in ${Math.round(r.durationMs)} ms`);
  };

  let response: HttpResponseData | undefined;
  try {
    ctx = await buildVariableContext(sources);
    const eff = input.collection ? resolveEffectiveConfig(input.collection, request) : standaloneConfig(request);

    // ---- pre-request scripts (outermost first). They see the unresolved request.
    const original: ScriptRequest = {
      method: request.method,
      url: scriptUrl(request),
      headers: eff.headers.map((h) => [h.key, h.value]),
      body: bodyTextForScript(request.body),
    };
    let scriptReq: ScriptRequest = { ...original, headers: [...original.headers] };
    const pre = eff.scripts.filter((s) => s.scripts.pre.trim());
    if (pre.length && !scriptsEnabled) {
      note('script', 'Pre-request scripts were not run (scripts are disabled for this workspace).');
      out.console.push({ level: 'warn', message: 'Scripts are disabled (untrusted workspace or setting). Pre-request scripts were skipped.', at: Date.now() });
    } else {
      for (const s of pre) {
        const label = `Pre-request script (${s.level} "${s.name}")`;
        const r = await runUserScript(scriptOptions(s.scripts.pre, 'pre', scriptReq));
        absorb(r, label);
        if (r.cancelled) throw new ReqvynError('CANCELLED', 'The request was cancelled.');
        if (r.error) throw new ReqvynError('SCRIPT', `${label} failed: ${redact(r.error.message)}${r.error.line ? ` (line ${r.error.line})` : ''}`);
        if (r.skipRequest) {
          out.skipped = true;
          note('script', `${label} skipped the request.`);
          return finish();
        }
        scriptReq = r.request;
      }
    }

    // ---- resolve the request
    const settings = eff.settings;
    const encode = settings.encodeUrl !== false;
    const resolve = (s: string) => ctx!.resolve(s);
    const urlTemplate = scriptReq.url !== original.url ? scriptReq.url : request.url;
    const urlDetail = ctx.resolveDetailed(urlTemplate);
    const unresolved = new Set(urlDetail.unresolved);
    let url =
      scriptReq.url !== original.url
        ? buildUrl(urlDetail.value, [], { encode })
        : buildUrl(
            urlDetail.value,
            request.params.filter((p) => p.enabled && p.key).map((p) => ({ key: resolve(p.key), value: resolve(p.value) })),
            { encode },
          );
    let headers: Array<[string, string]> = [];
    for (const [k, v] of scriptReq.headers) {
      const d = ctx.resolveDetailed(v);
      d.unresolved.forEach((u) => unresolved.add(u));
      const key = resolve(k).trim();
      if (key) headers.push([key, d.value]);
    }
    if (unresolved.size) note('info', `Unresolved variables: ${[...unresolved].map((u) => `{{${u}}}`).join(', ')}`);
    const cookies = request.cookies.filter((c) => c.enabled && c.key).map((c) => `${resolve(c.key)}=${resolve(c.value)}`);
    if (cookies.length) {
      const i = headers.findIndex(([k]) => k.toLowerCase() === 'cookie');
      if (i >= 0) headers[i] = [headers[i]![0], `${headers[i]![1]}; ${cookies.join('; ')}`];
      else headers.push(['Cookie', cookies.join('; ')]);
    }
    const method = resolve(scriptReq.method).trim().toUpperCase() || 'GET';
    const body: PreparedBody | undefined = await prepareBody(request.body, resolve, {
      baseDir: opts.baseDir,
      override: scriptReq.body !== original.body ? (scriptReq.body ?? '') : undefined,
    });
    const ct = body?.contentType ?? defaultContentType(request.body);
    if (body && ct && !hasHeader(headers, 'content-type')) headers.push(['Content-Type', ct]);

    // ---- authentication
    const auth = eff.auth;
    let tlsExtra: SendOptions['tls'] = {};
    const baseSend = opts.send ?? {};
    if (auth.type !== 'none' && auth.type !== 'inherit') {
      const res = await applyAuth(
        auth as ConcreteAuth,
        { method, url, headers, bodyBytes: body?.bytes ? Buffer.from(body.bytes) : undefined, openBody: body ? () => body.open() : undefined },
        {
          resolve,
          tokenStore: opts.tokenStore,
          interactive: opts.interactive,
          sendOptions: { proxy: baseSend.proxy, tls: baseSend.tls, timeoutMs: baseSend.timeoutMs, userAgent: baseSend.userAgent, allowUrl: baseSend.allowUrl },
          signal: input.signal,
          baseDir: opts.baseDir,
          log: (m) => note('auth', redact(m)),
        },
      );
      url = res.url;
      headers = res.headers;
      if (res.tls) tlsExtra = res.tls;
      note('auth', `${res.description} (from ${eff.authSource.level}${eff.authSource.level === 'request' ? '' : ` "${eff.authSource.name}"`})`);
    }

    // ---- send
    const send: SendOptions = {
      ...baseSend,
      timeoutMs: settings.timeoutMs ?? baseSend.timeoutMs,
      followRedirects: settings.followRedirects ?? baseSend.followRedirects,
      maxRedirects: settings.maxRedirects ?? baseSend.maxRedirects,
      decompress: settings.decompress ?? baseSend.decompress,
      maxBodyBytes: settings.maxResponseBytes ?? baseSend.maxBodyBytes,
      cookieJar: settings.useCookieJar === false ? null : baseSend.cookieJar,
      tls: { ...baseSend.tls, ...(settings.verifyTls === false ? { verify: false } : {}), ...tlsExtra },
      signal: input.signal,
      downloadPath: input.downloadPath,
      onChunk: input.onChunk,
    };
    const transport = opts.transport ?? new NodeHttpTransport();
    response = await transport.send({ method, url, headers, body }, send);
    if (auth.type === 'digest' && response.status === 401) {
      const retry = answerChallenge(auth, { method, url, headers }, response, { resolve });
      if (retry) {
        note('auth', 'Digest challenge received; retrying with credentials.');
        const prevTimeline = response.timeline;
        response = await transport.send({ method, url, headers: retry, body }, send);
        response.timeline = [...prevTimeline, ...response.timeline];
      }
    }
    response.timeline = [...timeline, ...response.timeline];
    timeline.length = 0;
    response.sentRequest = {
      ...response.sentRequest,
      url: redact(response.sentRequest.url),
      headers: response.sentRequest.headers.map(([k, v]) => [k, redact(v)]),
      bodyPreview: response.sentRequest.bodyPreview && redact(response.sentRequest.bodyPreview),
    };
    out.response = response;

    // ---- post-response: extractions, scripts, assertions
    const rc: ResponseContext = {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      bodyText: decodeBase64Text(response.body.base64),
      timeMs: response.timings.totalMs,
      size: response.body.size,
      cookies: response.cookies,
      contentType: response.contentType,
    };
    for (const x of runExtractions(request.extractions, rc)) {
      if (x.error || x.value === undefined) {
        out.console.push({ level: 'warn', message: `Extraction into "${x.variable}" failed: ${x.error ?? 'no value'}`, at: Date.now() });
        out.tests.push({ id: `extract:${x.id}`, name: `Extract ${x.variable}`, passed: false, message: x.error ?? 'No value found', source: 'assertion' });
      } else {
        record(x.scope, x.variable, x.value);
      }
    }
    const post = eff.scripts.filter((s) => s.scripts.post.trim());
    if (post.length && !scriptsEnabled) {
      out.console.push({ level: 'warn', message: 'Scripts are disabled (untrusted workspace or setting). Post-response scripts were skipped.', at: Date.now() });
    } else {
      const sentReq: ScriptRequest = { method, url, headers: response.sentRequest.headers, body: response.sentRequest.bodyPreview };
      for (const s of post) {
        const label = `Post-response script (${s.level} "${s.name}")`;
        const r = await runUserScript(scriptOptions(s.scripts.post, 'post', sentReq, rc));
        absorb(r, label);
        if (r.cancelled) throw new ReqvynError('CANCELLED', 'The request was cancelled.');
        if (r.error) {
          out.tests.push({
            id: `script-error:${s.level}:${out.tests.length}`,
            name: `${label} error`,
            passed: false,
            message: `${redact(r.error.message)}${r.error.line ? ` (line ${r.error.line})` : ''}`,
            source: 'script',
          });
        }
      }
    }
    for (const t of eff.tests) {
      if (!t.group || t.group.enabled === false || !t.group.items?.length) continue;
      const results = evaluateAssertions(t.group, rc, { interpolate: resolve });
      out.tests.push(...(t.level === 'request' ? results : results.map((r) => prefixTest(r, `[${t.level}: ${t.name}] `))).map((r) => redactTest(r, redact)));
    }
  } catch (e) {
    const err = toErrorJson(e);
    out.error = { ...err, message: redact(err.message || errorMessage(e)), hint: err.hint && redact(err.hint) };
  }
  return finish();

  function finish(): ExecutionOutcome {
    out.durationMs = Date.now() - started;
    return out;
  }
}

function prefixTest(t: TestResult, prefix: string): TestResult {
  return { ...t, name: prefix + t.name };
}

function redactTest(t: TestResult, redact: (s: string) => string): TestResult {
  return { ...t, name: redact(t.name), message: t.message && redact(t.message), children: t.children?.map((c) => redactTest(c, redact)) };
}

function safeSnapshot(ctx: VariableContext): Record<string, string> {
  try {
    return ctx.snapshot();
  } catch {
    return {};
  }
}

/** Execute a request of a collection by id (convenience for CLI and runner). */
export function findRequest(collection: Collection, requestId: string): HttpRequest {
  const r = collection.requests.find((x) => x.id === requestId);
  if (!r) throw new ReqvynError('NOT_FOUND', `Request ${requestId} not found in collection "${collection.name}".`);
  return r;
}
