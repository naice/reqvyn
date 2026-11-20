import { SENSITIVE_AUTH_FIELDS, isTemplate, type Auth, type Collection, type Environment, type Folder, type HttpRequest, type KeyValue } from '@reqvyn/core';
import { REDACTED, deepClone, isSensitiveHeader, isSensitiveKey } from '@reqvyn/shared';

/**
 * Detection and removal of embedded secrets. Used by exporters (blank by default), the export
 * review UI (findings list) and clipboard/package imports (warnings).
 */

export type FindingEntity = 'collection' | 'folder' | 'request' | 'environment';

export interface SensitiveFinding {
  entityType: FindingEntity;
  entityId: string;
  /** Human readable location, e.g. "Users API / Users / Get user". */
  location: string;
  /** Field path, e.g. "auth.token", "headers.Authorization", "variables.apiKey", "url", "body". */
  field: string;
  reason: string;
  /** Masked preview of the value (never the full value). */
  preview: string;
  /** True when the exporter blanked the value. */
  removed?: boolean;
}

export function maskPreview(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return REDACTED;
  return `${v.slice(0, 4)}${REDACTED}`;
}

const VALUE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, reason: 'JWT-like token' },
  { re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, reason: 'AWS access key id' },
  { re: /-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, reason: 'Private key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, reason: 'GitHub token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, reason: 'GitHub token' },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, reason: 'Slack token' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, reason: 'Google API key' },
  { re: /\b[sr]k_live_[0-9A-Za-z]{16,}\b/, reason: 'Stripe live key' },
  { re: /\bglpat-[0-9A-Za-z_-]{20,}\b/, reason: 'GitLab token' },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/, reason: 'npm token' },
];

/** Returns a reason when the text contains a secret-looking literal. Template references are ignored. */
export function detectSecretValue(text: string): { reason: string; match: string } | undefined {
  if (!text) return undefined;
  for (const p of VALUE_PATTERNS) {
    const m = p.re.exec(text);
    if (m) return { reason: p.reason, match: m[0] };
  }
  return undefined;
}

/** A literal (non-template) value. `Bearer {{token}}` is a template; `Bearer abc` is a literal. */
export function isLiteral(value: string): boolean {
  return value.trim() !== '' && !isTemplate(value);
}

const URL_SECRET_PARAM = /^(access_?token|token|api[-_]?key|apikey|key|secret|client_secret|password|passwd|pwd|sig|signature|auth|session|sessionid|code)$/i;

interface Ctx {
  entityType: FindingEntity;
  entityId: string;
  location: string;
}

function push(out: SensitiveFinding[], ctx: Ctx, field: string, reason: string, value: string): void {
  out.push({ ...ctx, field, reason, preview: maskPreview(value) });
}

function scanAuth(auth: Auth, ctx: Ctx, out: SensitiveFinding[]): void {
  const fields = SENSITIVE_AUTH_FIELDS[auth.type] ?? [];
  const rec = auth as unknown as Record<string, unknown>;
  for (const f of fields) {
    const v = rec[f];
    if (typeof v === 'string' && isLiteral(v)) push(out, ctx, `auth.${f}`, `Literal ${auth.type} ${f}`, v);
  }
  if (auth.type === 'awsv4' && isLiteral(auth.accessKeyId) && /^(AKIA|ASIA)/.test(auth.accessKeyId))
    push(out, ctx, 'auth.accessKeyId', 'AWS access key id', auth.accessKeyId);
}

function scanKeyValues(list: KeyValue[], field: string, ctx: Ctx, out: SensitiveFinding[], kind: 'header' | 'param' | 'variable' | 'cookie' | 'field'): void {
  for (const item of list) {
    const v = item.value ?? '';
    if (!isLiteral(v)) continue;
    const f = `${field}.${item.key}`;
    if (kind === 'variable' && item.secret) {
      push(out, ctx, f, 'Secret variable with a stored value', v);
      continue;
    }
    if (kind === 'header' && isSensitiveHeader(item.key)) {
      push(out, ctx, f, `Sensitive header "${item.key}" with a literal value`, v);
      continue;
    }
    if (kind === 'cookie') {
      push(out, ctx, f, 'Cookie value', v);
      continue;
    }
    if (isSensitiveKey(item.key) || (kind === 'param' && URL_SECRET_PARAM.test(item.key))) {
      push(out, ctx, f, `Sensitive-looking ${kind} "${item.key}" with a literal value`, v);
      continue;
    }
    const d = detectSecretValue(v);
    if (d) push(out, ctx, f, d.reason, d.match);
  }
}

function scanUrl(url: string, ctx: Ctx, out: SensitiveFinding[]): void {
  const cred = /^[a-z][a-z0-9+.-]*:\/\/([^/@\s:]+):([^/@\s]+)@/i.exec(url);
  if (cred && isLiteral(cred[2] ?? '')) push(out, ctx, 'url', 'Credentials embedded in the URL', cred[2] ?? '');
  const q = url.indexOf('?');
  if (q >= 0) {
    for (const part of url.slice(q + 1).split('&')) {
      const [k = '', v = ''] = part.split('=');
      if (isLiteral(v) && (URL_SECRET_PARAM.test(k) || isSensitiveKey(k))) push(out, ctx, 'url', `Token-like query parameter "${k}" in the URL`, v);
    }
  }
  const d = detectSecretValue(url);
  if (d) push(out, ctx, 'url', d.reason, d.match);
}

const JSON_SECRET_FIELD = /"(password|passwd|secret|client_secret|token|access_token|refresh_token|api_?key|apikey|private_key)"\s*:\s*"([^"]+)"/gi;

function scanBody(r: HttpRequest, ctx: Ctx, out: SensitiveFinding[]): void {
  const b = r.body;
  if (b.mode === 'json' || b.mode === 'text' || b.mode === 'xml' || b.mode === 'graphql') {
    const text = b.mode === 'graphql' ? `${b.query}\n${b.variables}` : b.text;
    for (const m of text.matchAll(JSON_SECRET_FIELD)) {
      const v = m[2] ?? '';
      if (isLiteral(v)) push(out, ctx, 'body', `Literal "${m[1]}" in the body`, v);
    }
    const d = detectSecretValue(text);
    if (d) push(out, ctx, 'body', d.reason, d.match);
  } else if (b.mode === 'urlencoded') scanKeyValues(b.fields, 'body', ctx, out, 'field');
  else if (b.mode === 'multipart')
    scanKeyValues(
      b.parts.filter((p) => p.type === 'text').map((p) => ({ id: p.id, key: p.key, value: p.value, enabled: p.enabled })),
      'body',
      ctx,
      out,
      'field',
    );
}

export function scanRequest(r: HttpRequest, location = r.name): SensitiveFinding[] {
  const out: SensitiveFinding[] = [];
  const ctx: Ctx = { entityType: 'request', entityId: r.id, location };
  scanAuth(r.auth, ctx, out);
  scanUrl(r.url, ctx, out);
  scanKeyValues(r.params, 'params', ctx, out, 'param');
  scanKeyValues(r.headers, 'headers', ctx, out, 'header');
  scanKeyValues(r.cookies, 'cookies', ctx, out, 'cookie');
  scanKeyValues(r.variables, 'variables', ctx, out, 'variable');
  scanBody(r, ctx, out);
  for (const [k, s] of [['scripts.pre', r.scripts.pre], ['scripts.post', r.scripts.post]] as const) {
    const d = detectSecretValue(s);
    if (d) push(out, ctx, k, d.reason, d.match);
  }
  return out;
}

function folderPath(c: Collection, f: Folder | null): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let cur = f;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    names.unshift(cur.name);
    const pid: string | null = cur.parentId;
    cur = pid ? c.folders.find((x) => x.id === pid) ?? null : null;
  }
  return [c.name, ...names].join(' / ');
}

export function scanCollection(c: Collection): SensitiveFinding[] {
  const out: SensitiveFinding[] = [];
  const cctx: Ctx = { entityType: 'collection', entityId: c.id, location: c.name };
  scanAuth(c.auth, cctx, out);
  scanKeyValues(c.headers, 'headers', cctx, out, 'header');
  scanKeyValues(c.variables, 'variables', cctx, out, 'variable');
  for (const f of c.folders) {
    const ctx: Ctx = { entityType: 'folder', entityId: f.id, location: folderPath(c, f) };
    scanAuth(f.auth, ctx, out);
    scanKeyValues(f.headers, 'headers', ctx, out, 'header');
    scanKeyValues(f.variables, 'variables', ctx, out, 'variable');
  }
  for (const r of c.requests) {
    const parent = r.parentId ? c.folders.find((f) => f.id === r.parentId) ?? null : null;
    out.push(...scanRequest(r, `${folderPath(c, parent)} / ${r.name}`));
  }
  return out;
}

export function scanEnvironment(env: Environment): SensitiveFinding[] {
  const out: SensitiveFinding[] = [];
  scanKeyValues(env.variables, 'variables', { entityType: 'environment', entityId: env.id, location: env.name }, out, 'variable');
  return out;
}

/** Scan a collection, an environment or a list of either for embedded secrets. */
export function scanForSecrets(input: Collection | Environment | Array<Collection | Environment>): SensitiveFinding[] {
  const list = Array.isArray(input) ? input : [input];
  return list.flatMap((x) => ('requests' in x ? scanCollection(x) : scanEnvironment(x)));
}

// ---------------------------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------------------------

export interface SanitizeOptions {
  /** Keep literal auth secrets and secret variable values (default false). */
  includeSecrets?: boolean;
  /** Blank literal values of sensitive headers such as Authorization/Cookie/X-Api-Key (default true). */
  redactSensitiveHeaders?: boolean;
}

export function blankAuth(auth: Auth, ctx: Ctx, out: SensitiveFinding[]): Auth {
  const fields = SENSITIVE_AUTH_FIELDS[auth.type] ?? [];
  const copy = { ...auth } as Record<string, unknown>;
  for (const f of fields) {
    const v = copy[f];
    if (typeof v === 'string' && isLiteral(v)) {
      out.push({ ...ctx, field: `auth.${f}`, reason: `Literal ${auth.type} ${f} removed`, preview: maskPreview(v), removed: true });
      copy[f] = '';
    }
  }
  return copy as unknown as Auth;
}

function blankVariables(list: KeyValue[], field: string, ctx: Ctx, out: SensitiveFinding[]): KeyValue[] {
  return list.map((v) => {
    if (v.secret && v.value) {
      out.push({ ...ctx, field: `${field}.${v.key}`, reason: 'Secret variable value removed', preview: maskPreview(v.value), removed: true });
      return { ...v, value: '' };
    }
    return v;
  });
}

function blankHeaders(list: KeyValue[], ctx: Ctx, out: SensitiveFinding[]): KeyValue[] {
  return list.map((h) => {
    if (isSensitiveHeader(h.key) && isLiteral(h.value)) {
      out.push({ ...ctx, field: `headers.${h.key}`, reason: `Literal "${h.key}" header value removed`, preview: maskPreview(h.value), removed: true });
      return { ...h, value: '' };
    }
    return h;
  });
}

export function sanitizeRequest(r: HttpRequest, opts: SanitizeOptions = {}, location = r.name): { request: HttpRequest; removed: SensitiveFinding[] } {
  const removed: SensitiveFinding[] = [];
  if (opts.includeSecrets) return { request: deepClone(r), removed };
  const ctx: Ctx = { entityType: 'request', entityId: r.id, location };
  const request = deepClone(r);
  request.auth = blankAuth(request.auth, ctx, removed);
  request.variables = blankVariables(request.variables, 'variables', ctx, removed);
  request.params = request.params.map((p) => {
    if (isLiteral(p.value) && p.value !== '' && (URL_SECRET_PARAM.test(p.key) || isSensitiveKey(p.key))) {
      removed.push({ ...ctx, field: `params.${p.key}`, reason: `Literal "${p.key}" query parameter removed`, preview: maskPreview(p.value), removed: true });
      return { ...p, value: '' };
    }
    return p;
  });
  if (opts.redactSensitiveHeaders !== false) {
    request.headers = blankHeaders(request.headers, ctx, removed);
    request.cookies = request.cookies.map((c) => {
      if (isLiteral(c.value)) {
        removed.push({ ...ctx, field: `cookies.${c.key}`, reason: 'Cookie value removed', preview: maskPreview(c.value), removed: true });
        return { ...c, value: '' };
      }
      return c;
    });
  }
  return { request, removed };
}

/** Return a copy of the collection with secrets blanked, plus the list of removed values. */
export function sanitizeCollection(c: Collection, opts: SanitizeOptions = {}): { collection: Collection; removed: SensitiveFinding[] } {
  const removed: SensitiveFinding[] = [];
  const collection = deepClone(c);
  if (opts.includeSecrets) return { collection, removed };
  const cctx: Ctx = { entityType: 'collection', entityId: c.id, location: c.name };
  collection.auth = blankAuth(collection.auth, cctx, removed);
  collection.variables = blankVariables(collection.variables, 'variables', cctx, removed);
  if (opts.redactSensitiveHeaders !== false) collection.headers = blankHeaders(collection.headers, cctx, removed);
  collection.folders = collection.folders.map((f) => {
    const ctx: Ctx = { entityType: 'folder', entityId: f.id, location: folderPath(c, f) };
    return {
      ...f,
      auth: blankAuth(f.auth, ctx, removed),
      variables: blankVariables(f.variables, 'variables', ctx, removed),
      headers: opts.redactSensitiveHeaders !== false ? blankHeaders(f.headers, ctx, removed) : f.headers,
    };
  });
  collection.requests = collection.requests.map((r) => {
    const parent = r.parentId ? c.folders.find((f) => f.id === r.parentId) ?? null : null;
    const res = sanitizeRequest(r, opts, `${folderPath(c, parent)} / ${r.name}`);
    removed.push(...res.removed);
    return res.request;
  });
  return { collection, removed };
}

export interface EnvironmentTemplateOptions {
  /** Keep non-secret values even when they look sensitive (default false). */
  includeEnvironmentValues?: boolean;
  /** Keep values of variables marked `secret: true` (default false). */
  includeSecrets?: boolean;
}

/** Turn an environment into a shareable template: secret and sensitive-looking values are blanked. */
export function environmentTemplate(env: Environment, opts: EnvironmentTemplateOptions = {}): { environment: Environment; removed: SensitiveFinding[] } {
  const removed: SensitiveFinding[] = [];
  const ctx: Ctx = { entityType: 'environment', entityId: env.id, location: env.name };
  const variables = env.variables.map((v) => {
    if (!v.value) return { ...v };
    if (v.secret) {
      if (opts.includeSecrets) return { ...v };
      removed.push({ ...ctx, field: `variables.${v.key}`, reason: 'Secret variable value removed', preview: maskPreview(v.value), removed: true });
      return { ...v, value: '' };
    }
    if (opts.includeEnvironmentValues) return { ...v };
    const sensitive = isLiteral(v.value) && (isSensitiveKey(v.key) || detectSecretValue(v.value) !== undefined);
    if (sensitive) {
      removed.push({ ...ctx, field: `variables.${v.key}`, reason: 'Sensitive-looking value removed', preview: maskPreview(v.value), removed: true });
      return { ...v, value: '' };
    }
    return { ...v };
  });
  return { environment: { ...env, variables }, removed };
}
