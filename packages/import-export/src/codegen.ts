import { CODEGEN_TARGETS, isTemplate, resolveEffectiveConfig, type Auth, type CodegenTarget, type Collection, type HttpRequest, type KeyValue, type RequestSettings } from '@reqvyn/core';
import { isSensitiveHeader, isSensitiveKey } from '@reqvyn/shared';
import type { ExportWarning } from './types.js';
import { buildUrl } from './util.js';

/**
 * Code generation for a single request. Variables (`{{name}}`) are kept verbatim unless values are
 * supplied; literal credentials are always replaced with placeholders such as `<TOKEN>` unless
 * `includeSecrets` is explicitly set.
 */

export { CODEGEN_TARGETS, type CodegenTarget };

export interface CodegenOptions {
  /** Collection the request belongs to: inherited headers, auth and settings are applied. */
  collection?: Collection;
  /** Substitute `{{name}}` references with these values (others are kept as-is). */
  variables?: Record<string, string>;
  /** Keep literal secret values (default false: placeholders are used). */
  includeSecrets?: boolean;
  /** curl only: put each option on its own line (default true). */
  multiline?: boolean;
}

export interface CodegenResult {
  target: CodegenTarget;
  /** Editor language id for syntax highlighting. */
  language: string;
  code: string;
  warnings: ExportWarning[];
}

export const CODEGEN_LABELS: Record<CodegenTarget, string> = {
  curl: 'cURL',
  fetch: 'JavaScript (fetch)',
  typescript: 'TypeScript (fetch)',
  node: 'Node.js (fetch)',
  python: 'Python (requests)',
  csharp: 'C# (HttpClient)',
  powershell: 'PowerShell (Invoke-RestMethod)',
};

const LANGUAGES: Record<CodegenTarget, string> = {
  curl: 'shellscript',
  fetch: 'javascript',
  typescript: 'typescript',
  node: 'javascript',
  python: 'python',
  csharp: 'csharp',
  powershell: 'powershell',
};

// ---------------------------------------------------------------------------------------------
// Request preparation (shared by all targets)
// ---------------------------------------------------------------------------------------------

export type PreparedBody =
  | { kind: 'none' }
  | { kind: 'text'; text: string; json?: unknown }
  | { kind: 'form'; fields: Array<[string, string]> }
  | { kind: 'multipart'; parts: Array<{ name: string; value?: string; filePath?: string; contentType?: string }> }
  | { kind: 'file'; filePath: string };

export interface PreparedRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  /** Content type of the body (also present in `headers`). */
  contentType?: string;
  body: PreparedBody;
  /** Basic/digest credentials rendered natively by curl (`-u`) and python (`auth=`). */
  basic?: { username: string; password: string; digest: boolean };
  clientCert?: { cert: string; key: string };
  settings: RequestSettings;
  warnings: ExportWarning[];
}

function placeholderFor(header: string, value: string): string {
  const h = header.toLowerCase();
  if (h === 'authorization' || h === 'proxy-authorization') {
    const m = /^(\w+)\s+/.exec(value);
    const scheme = m?.[1] ?? '';
    if (/^basic$/i.test(scheme)) return `${scheme} <BASE64_CREDENTIALS>`;
    return scheme ? `${scheme} <TOKEN>` : '<TOKEN>';
  }
  if (h === 'cookie') return '<COOKIE>';
  if (/api[-_]?key|apikey/.test(h)) return '<API_KEY>';
  return '<SECRET>';
}

/** Redact a value unless it is a pure template reference / empty. Partially templated values keep their templates. */
function secretValue(value: string, placeholder: string, keep: boolean): string {
  if (keep || !value || !value.trim()) return value;
  if (isTemplate(value) && value.replace(/\{\{[^{}]*\}\}/g, '').trim() === '') return value;
  return placeholder;
}

function substitute(s: string, vars: Record<string, string> | undefined): string {
  if (!vars) return s;
  return s.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? (vars[name] ?? '') : m));
}

function authHeaders(auth: Auth, keep: boolean, p: PreparedRequest, query: KeyValue[]): void {
  const w = p.warnings;
  switch (auth.type) {
    case 'inherit':
    case 'none':
      return;
    case 'basic':
    case 'digest':
      p.basic = { username: auth.username, password: secretValue(auth.password, '<PASSWORD>', keep), digest: auth.type === 'digest' };
      return;
    case 'bearer':
      p.headers.push(['Authorization', `${auth.prefix || 'Bearer'} ${secretValue(auth.token, '<TOKEN>', keep)}`.trim()]);
      return;
    case 'apikey': {
      const v = secretValue(auth.value, '<API_KEY>', keep);
      if (auth.in === 'query') query.push({ id: 'auth', key: auth.key, value: v, enabled: true });
      else p.headers.push([auth.key || 'X-API-Key', v]);
      return;
    }
    case 'oauth2':
      p.headers.push(['Authorization', `${auth.tokenPrefix || 'Bearer'} <ACCESS_TOKEN>`]);
      w.push({ code: 'info', message: 'OAuth 2.0: obtain an access token first and replace <ACCESS_TOKEN>.', field: 'auth' });
      return;
    case 'jwt':
      if (auth.addTo === 'query') query.push({ id: 'auth', key: auth.queryParam || 'token', value: '<JWT>', enabled: true });
      else p.headers.push(['Authorization', `${auth.headerPrefix ? `${auth.headerPrefix} ` : ''}<JWT>`]);
      w.push({ code: 'info', message: 'JWT auth: generate a signed token and replace <JWT>.', field: 'auth' });
      return;
    case 'awsv4':
      p.headers.push(['Authorization', '<AWS_SIGV4_AUTHORIZATION>'], ['X-Amz-Date', '<AMZ_DATE>']);
      if (auth.sessionToken) p.headers.push(['X-Amz-Security-Token', '<AWS_SESSION_TOKEN>']);
      w.push({ code: 'unsupported-feature', message: 'AWS Signature v4 must be computed per request; use an AWS SDK or replace the placeholders.', field: 'auth' });
      return;
    case 'clientcert':
      p.clientCert = { cert: auth.certPath || auth.pfxPath || '<CERT_PATH>', key: auth.keyPath || '<KEY_PATH>' };
      return;
  }
}

export function prepareRequest(request: HttpRequest, opts: CodegenOptions = {}): PreparedRequest {
  const keep = opts.includeSecrets === true;
  const vars = opts.variables;
  const sub = (s: string) => substitute(s, vars);
  const eff = opts.collection ? resolveEffectiveConfig(opts.collection, request) : undefined;
  const p: PreparedRequest = {
    method: request.method.toUpperCase(),
    url: '',
    headers: [],
    body: { kind: 'none' },
    settings: eff ? eff.settings : request.settings,
    warnings: [],
  };
  const query = request.params.filter((x) => x.enabled && x.key).map((x) => ({ ...x, value: isSensitiveKey(x.key) ? secretValue(x.value, '<SECRET>', keep) : x.value }));
  const auth = eff ? eff.auth : request.auth;
  if (!eff && request.auth.type === 'inherit')
    p.warnings.push({ code: 'info', message: 'The request inherits its auth from its folder/collection, which was not provided.', field: 'auth' });
  authHeaders(auth, keep, p, query);
  const headers = eff ? eff.headers : request.headers.filter((h) => h.enabled && h.key);
  for (const h of headers) {
    const value = isSensitiveHeader(h.key) ? secretValue(h.value, placeholderFor(h.key, h.value), keep) : h.value;
    const existing = p.headers.findIndex(([k]) => k.toLowerCase() === h.key.toLowerCase());
    if (existing >= 0 && /^authorization$/i.test(h.key)) p.headers.splice(existing, 1);
    p.headers.push([h.key, value]);
  }
  const cookies = request.cookies.filter((c) => c.enabled && c.key);
  if (cookies.length) p.headers.push(['Cookie', cookies.map((c) => `${c.key}=${secretValue(c.value, '<COOKIE>', keep)}`).join('; ')]);
  p.url = sub(buildUrl(request.url, query));

  const hasHeader = (n: string) => p.headers.some(([k]) => k.toLowerCase() === n.toLowerCase());
  const setCt = (ct: string) => {
    if (!hasHeader('content-type')) p.headers.push(['Content-Type', ct]);
  };
  const b = request.body;
  switch (b.mode) {
    case 'none':
      break;
    case 'json': {
      setCt('application/json');
      let json: unknown;
      try {
        json = JSON.parse(sub(b.text));
      } catch {
        json = undefined;
      }
      p.body = { kind: 'text', text: sub(b.text), ...(json !== undefined ? { json } : {}) };
      break;
    }
    case 'xml':
      setCt('application/xml');
      p.body = { kind: 'text', text: sub(b.text) };
      break;
    case 'text':
      setCt(b.contentType || 'text/plain');
      p.body = { kind: 'text', text: sub(b.text) };
      break;
    case 'graphql': {
      setCt('application/json');
      let variables: unknown;
      try {
        variables = b.variables.trim() ? JSON.parse(sub(b.variables)) : undefined;
      } catch {
        variables = undefined;
        p.warnings.push({ code: 'converted', message: 'GraphQL variables are not valid JSON and were omitted.', field: 'body.variables' });
      }
      const json = { query: sub(b.query), ...(variables !== undefined ? { variables } : {}) };
      p.body = { kind: 'text', text: JSON.stringify(json), json };
      break;
    }
    case 'urlencoded':
      setCt('application/x-www-form-urlencoded');
      p.body = { kind: 'form', fields: b.fields.filter((f) => f.enabled && f.key).map((f) => [sub(f.key), sub(f.value)]) };
      break;
    case 'multipart':
      // The multipart boundary is generated by the client library; never send a fixed Content-Type.
      p.headers = p.headers.filter(([k]) => k.toLowerCase() !== 'content-type');
      p.body = {
        kind: 'multipart',
        parts: b.parts
          .filter((x) => x.enabled && x.key)
          .map((x) =>
            x.type === 'file'
              ? { name: sub(x.key), filePath: x.filePath || '<FILE_PATH>', ...(x.contentType ? { contentType: x.contentType } : {}) }
              : { name: sub(x.key), value: sub(x.value), ...(x.contentType ? { contentType: x.contentType } : {}) },
          ),
      };
      break;
    case 'binary':
      setCt(b.contentType || 'application/octet-stream');
      p.body = { kind: 'file', filePath: b.filePath || '<FILE_PATH>' };
      break;
  }
  p.headers = p.headers.map(([k, v]) => [sub(k), sub(v)]);
  p.contentType = p.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
  if (p.settings.verifyTls === false)
    p.warnings.push({ code: 'insecure', message: 'TLS certificate verification is disabled for this request; the generated code does the same.', field: 'settings.verifyTls' });
  return p;
}

// ---------------------------------------------------------------------------------------------
// String escaping per language
// ---------------------------------------------------------------------------------------------

/** POSIX shell single-quoted string. */
export function shellQuote(s: string): string {
  if (s !== '' && /^[A-Za-z0-9_\-+=.,/:@%^]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** JavaScript/TypeScript string literal. */
export function jsString(s: string): string {
  return JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0');
}

/** Python double-quoted string literal. */
export function pyString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\x${hex(c, 2)}`;
    else if (c === 0x2028 || c === 0x2029) out += `\\u${hex(c, 4)}`;
    else out += ch;
  }
  return `${out}"`;
}

/** C# regular string literal. */
export function csString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\0') out += '\\0';
    else if (c < 0x20 || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029) out += `\\u${hex(c, 4)}`;
    else out += ch;
  }
  return `${out}"`;
}

/** PowerShell verbatim (single-quoted) string. PowerShell also treats typographic single quotes as quotes. */
export function psString(s: string): string {
  return `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, (q) => q + q)}'`;
}

// ---------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------

function fileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || 'file';
}

function genCurl(p: PreparedRequest, opts: CodegenOptions): string {
  const args: string[] = [];
  if (p.method === 'HEAD') args.push('--head');
  else if (p.method !== 'GET' || p.body.kind !== 'none') {
    const implied = p.body.kind !== 'none' && p.method === 'POST';
    if (!implied) args.push(`-X ${shellQuote(p.method)}`);
  }
  args.push(shellQuote(p.url));
  for (const [k, v] of p.headers) args.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  if (p.basic) {
    if (p.basic.digest) args.push('--digest');
    args.push(`-u ${shellQuote(`${p.basic.username}:${p.basic.password}`)}`);
  }
  if (p.clientCert) args.push(`--cert ${shellQuote(p.clientCert.cert)}`, `--key ${shellQuote(p.clientCert.key)}`);
  switch (p.body.kind) {
    case 'text':
      args.push(`--data-raw ${shellQuote(p.body.text)}`);
      break;
    case 'form':
      for (const [k, v] of p.body.fields) args.push(`--data-urlencode ${shellQuote(`${k}=${v}`)}`);
      break;
    case 'multipart':
      for (const part of p.body.parts) {
        if (part.filePath !== undefined) args.push(`-F ${shellQuote(`${part.name}=@${part.filePath}${part.contentType ? `;type=${part.contentType}` : ''}`)}`);
        else args.push(`--form-string ${shellQuote(`${part.name}=${part.value ?? ''}`)}`);
      }
      break;
    case 'file':
      args.push(`--data-binary ${shellQuote(`@${p.body.filePath}`)}`);
      break;
    case 'none':
      break;
  }
  if (p.settings.verifyTls === false) args.push('-k');
  if (p.settings.followRedirects === true) args.push('-L');
  if (p.settings.maxRedirects !== undefined && p.settings.followRedirects !== false) args.push(`--max-redirs ${p.settings.maxRedirects}`);
  if (p.settings.timeoutMs) args.push(`-m ${Math.max(1, Math.ceil(p.settings.timeoutMs / 1000))}`);
  if (p.settings.decompress) args.push('--compressed');
  return `curl ${args.join(opts.multiline === false ? ' ' : ' \\\n  ')}`;
}

function indentBlock(text: string, indent: string): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? l : indent + l))
    .join('\n');
}

function jsBodyLines(p: PreparedRequest, node: boolean): { pre: string[]; body?: string } {
  const pre: string[] = [];
  switch (p.body.kind) {
    case 'none':
      return { pre };
    case 'text':
      return { pre, body: p.body.json !== undefined && isPlainJson(p.body.json) ? `JSON.stringify(${indentBlock(JSON.stringify(p.body.json, null, 2), '  ')})` : jsString(p.body.text) };
    case 'form':
      return { pre, body: `new URLSearchParams([\n${p.body.fields.map(([k, v]) => `    [${jsString(k)}, ${jsString(v)}],`).join('\n')}\n  ])` };
    case 'multipart':
      pre.push('const form = new FormData();');
      for (const part of p.body.parts) {
        if (part.filePath !== undefined) {
          const blob = node
            ? `await openAsBlob(${jsString(part.filePath)}${part.contentType ? `, { type: ${jsString(part.contentType)} }` : ''})`
            : `fileInput.files[0] /* ${part.filePath.replace(/\*\//g, '* /')} */`;
          pre.push(`form.append(${jsString(part.name)}, ${blob}${node ? `, ${jsString(fileName(part.filePath))}` : ''});`);
        } else pre.push(`form.append(${jsString(part.name)}, ${jsString(part.value ?? '')});`);
      }
      return { pre, body: 'form' };
    case 'file':
      return { pre, body: node ? `await readFile(${jsString(p.body.filePath)})` : `fileInput.files[0] /* ${p.body.filePath.replace(/\*\//g, '* /')} */` };
  }
}

function isPlainJson(v: unknown): boolean {
  return typeof v === 'object' && v !== null;
}

function jsHeaders(p: PreparedRequest): string[] {
  const all: Array<[string, string]> = [...p.headers];
  if (p.basic) all.push(['Authorization', p.basic.digest ? 'Digest <DIGEST_CREDENTIALS>' : 'Basic <BASE64_CREDENTIALS>']);
  return all.map(([k, v]) => `    ${jsString(k)}: ${jsString(v)},`);
}

function genFetch(p: PreparedRequest, kind: 'fetch' | 'typescript' | 'node'): string {
  const node = kind === 'node';
  const lines: string[] = [];
  const { pre, body } = jsBodyLines(p, node);
  if (node) {
    const imports: string[] = [];
    if (p.body.kind === 'multipart' && p.body.parts.some((x) => x.filePath !== undefined)) imports.push("import { openAsBlob } from 'node:fs';");
    if (p.body.kind === 'file') imports.push("import { readFile } from 'node:fs/promises';");
    if (imports.length) lines.push(...imports, '');
    if (p.settings.verifyTls === false)
      lines.push('// TLS verification is disabled for this request in REQVYN. To do the same in Node.js, use an undici Agent', '// with { connect: { rejectUnauthorized: false } } — never in production.', '');
  } else if (p.settings.verifyTls === false) lines.push('// Note: TLS verification is disabled in REQVYN for this request; browsers/fetch cannot disable it.', '');
  if (p.basic && !node) lines.push('// Replace <BASE64_CREDENTIALS> with base64("username:password").');
  if (p.basic && node) lines.push(`const credentials = Buffer.from(${jsString(`${p.basic.username}:${p.basic.password}`)}).toString('base64');`);
  if (p.clientCert) lines.push('// Client certificate authentication is not configurable through fetch.');
  lines.push(...pre);
  if (pre.length) lines.push('');
  const headerLines = jsHeaders(p).map((l) => (node && p.basic && l.includes('<BASE64_CREDENTIALS>') ? l.replace(`"Basic <BASE64_CREDENTIALS>"`, '`Basic ${credentials}`') : l));
  const init: string[] = [`  method: ${jsString(p.method)},`];
  if (headerLines.length) init.push('  headers: {', ...headerLines, '  },');
  if (body) init.push(`  body: ${body},`);
  if (p.settings.followRedirects === false) init.push("  redirect: 'manual',");
  if (p.settings.timeoutMs) init.push(`  signal: AbortSignal.timeout(${p.settings.timeoutMs}),`);
  const ts = kind === 'typescript';
  lines.push(`const response${ts ? ': Response' : ''} = await fetch(${jsString(p.url)}, {`, ...init, '});');
  lines.push('');
  lines.push(`const text${ts ? ': string' : ''} = await response.text();`);
  lines.push('console.log(response.status, text);');
  if (ts) return ['async function main(): Promise<void> {', ...lines.map((l) => (l ? `  ${l}` : l)), '}', '', 'main().catch((err: unknown) => {', '  console.error(err);', '  process.exitCode = 1;', '});'].join('\n');
  return lines.join('\n');
}

function pyDict(entries: Array<[string, string]>, indent = '    '): string {
  return `{\n${entries.map(([k, v]) => `${indent}${pyString(k)}: ${pyString(v)},`).join('\n')}\n}`;
}

function pyLiteral(v: unknown, indent = ''): string {
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'None';
  if (typeof v === 'string') return pyString(v);
  const next = `${indent}    `;
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => `${next}${pyLiteral(x, next)},`).join('\n')}\n${indent}]` : '[]';
  if (typeof v === 'object') {
    const e = Object.entries(v as Record<string, unknown>);
    return e.length ? `{\n${e.map(([k, x]) => `${next}${pyString(k)}: ${pyLiteral(x, next)},`).join('\n')}\n${indent}}` : '{}';
  }
  return 'None';
}

function genPython(p: PreparedRequest): string {
  const lines = ['import requests', ''];
  const args = [pyString(p.method), 'url'];
  lines.push(`url = ${pyString(p.url)}`);
  const headers = p.headers;
  if (headers.length) {
    lines.push(`headers = ${pyDict(headers)}`);
    args.push('headers=headers');
  }
  switch (p.body.kind) {
    case 'text':
      if (p.body.json !== undefined && isPlainJson(p.body.json)) {
        lines.push(`payload = ${pyLiteral(p.body.json)}`);
        args.push('json=payload');
      } else {
        lines.push(`payload = ${pyString(p.body.text)}`);
        args.push('data=payload.encode("utf-8")');
      }
      break;
    case 'form':
      lines.push(`payload = ${pyDict(p.body.fields)}`);
      args.push('data=payload');
      break;
    case 'multipart': {
      const text = p.body.parts.filter((x) => x.filePath === undefined).map((x) => [x.name, x.value ?? ''] as [string, string]);
      const files = p.body.parts.filter((x) => x.filePath !== undefined);
      if (text.length) {
        lines.push(`data = ${pyDict(text)}`);
        args.push('data=data');
      }
      if (files.length) {
        lines.push(
          `files = [\n${files
            .map((f) => `    (${pyString(f.name)}, (${pyString(fileName(f.filePath ?? ''))}, open(${pyString(f.filePath ?? '')}, "rb")${f.contentType ? `, ${pyString(f.contentType)}` : ''})),`)
            .join('\n')}\n]`,
        );
        args.push('files=files');
      }
      break;
    }
    case 'file':
      lines.push(`payload = open(${pyString(p.body.filePath)}, "rb")`);
      args.push('data=payload');
      break;
    case 'none':
      break;
  }
  if (p.basic) {
    if (p.basic.digest) {
      lines[0] = 'import requests\nfrom requests.auth import HTTPDigestAuth';
      args.push(`auth=HTTPDigestAuth(${pyString(p.basic.username)}, ${pyString(p.basic.password)})`);
    } else args.push(`auth=(${pyString(p.basic.username)}, ${pyString(p.basic.password)})`);
  }
  if (p.clientCert) args.push(`cert=(${pyString(p.clientCert.cert)}, ${pyString(p.clientCert.key)})`);
  if (p.settings.verifyTls === false) args.push('verify=False');
  if (p.settings.followRedirects === false) args.push('allow_redirects=False');
  args.push(`timeout=${p.settings.timeoutMs ? Math.max(1, p.settings.timeoutMs / 1000) : 30}`);
  lines.push('', `response = requests.request(\n    ${args.join(',\n    ')},\n)`, '', 'print(response.status_code)', 'print(response.text)');
  if (p.settings.verifyTls === false) lines.splice(2, 0, '# WARNING: TLS certificate verification is disabled (verify=False).');
  return lines.join('\n');
}

const CONTENT_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'content-language', 'content-disposition', 'content-md5', 'content-range', 'expires', 'last-modified', 'allow', 'content-location']);

function genCSharp(p: PreparedRequest): string {
  const lines = ['using System;', 'using System.Collections.Generic;', 'using System.IO;', 'using System.Net.Http;', 'using System.Net.Http.Headers;', 'using System.Text;', ''];
  lines.push('using var handler = new HttpClientHandler();');
  if (p.settings.verifyTls === false) {
    lines.push('// WARNING: TLS certificate verification is disabled. Never use this in production.');
    lines.push('handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;');
  }
  if (p.settings.followRedirects === false) lines.push('handler.AllowAutoRedirect = false;');
  if (p.settings.maxRedirects !== undefined && p.settings.maxRedirects > 0) lines.push(`handler.MaxAutomaticRedirections = ${p.settings.maxRedirects};`);
  if (p.settings.decompress) lines.push('handler.AutomaticDecompression = System.Net.DecompressionMethods.All;');
  if (p.clientCert) lines.push(`// Client certificate: load ${p.clientCert.cert.replace(/\r?\n/g, ' ')} and add it to handler.ClientCertificates.`);
  lines.push('using var client = new HttpClient(handler);');
  if (p.settings.timeoutMs) lines.push(`client.Timeout = TimeSpan.FromMilliseconds(${p.settings.timeoutMs});`);
  lines.push(`using var request = new HttpRequestMessage(new HttpMethod(${csString(p.method)}), ${csString(p.url)});`);
  const contentHeaders = p.headers.filter(([k]) => CONTENT_HEADERS.has(k.toLowerCase()));
  for (const [k, v] of p.headers.filter(([k]) => !CONTENT_HEADERS.has(k.toLowerCase()))) lines.push(`request.Headers.TryAddWithoutValidation(${csString(k)}, ${csString(v)});`);
  if (p.basic)
    lines.push(
      p.basic.digest
        ? '// Digest auth: set handler.Credentials = new System.Net.NetworkCredential(username, password) before sending.'
        : `request.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes(${csString(`${p.basic.username}:${p.basic.password}`)})));`,
    );
  let hasContent = true;
  switch (p.body.kind) {
    case 'text':
      lines.push(`request.Content = new StringContent(${csString(p.body.text)}, Encoding.UTF8);`);
      break;
    case 'form':
      lines.push(
        `request.Content = new FormUrlEncodedContent(new List<KeyValuePair<string, string>>\n{\n${p.body.fields.map(([k, v]) => `    new(${csString(k)}, ${csString(v)}),`).join('\n')}\n});`,
      );
      break;
    case 'multipart': {
      lines.push('var form = new MultipartFormDataContent();');
      let fileCount = 0;
      for (const part of p.body.parts) {
        if (part.filePath !== undefined) {
          const v = `file${++fileCount}`;
          lines.push(`var ${v} = new StreamContent(File.OpenRead(${csString(part.filePath)}));`);
          if (part.contentType) lines.push(`${v}.Headers.ContentType = MediaTypeHeaderValue.Parse(${csString(part.contentType)});`);
          lines.push(`form.Add(${v}, ${csString(part.name)}, ${csString(fileName(part.filePath))});`);
        } else lines.push(`form.Add(new StringContent(${csString(part.value ?? '')}), ${csString(part.name)});`);
      }
      lines.push('request.Content = form;');
      break;
    }
    case 'file':
      lines.push(`request.Content = new StreamContent(File.OpenRead(${csString(p.body.filePath)}));`);
      break;
    case 'none':
      hasContent = false;
      break;
  }
  for (const [k, v] of contentHeaders) {
    if (!hasContent) {
      lines.push(`// Content header "${k.replace(/[\r\n]/g, ' ')}" ignored: the request has no body.`);
      continue;
    }
    if (k.toLowerCase() === 'content-type') lines.push(`request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(${csString(v)});`);
    else lines.push(`request.Content.Headers.TryAddWithoutValidation(${csString(k)}, ${csString(v)});`);
  }
  lines.push('', 'using var response = await client.SendAsync(request);', 'Console.WriteLine((int)response.StatusCode);', 'Console.WriteLine(await response.Content.ReadAsStringAsync());');
  return lines.join('\n');
}

const PS_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'MERGE']);

function genPowerShell(p: PreparedRequest): string {
  const lines: string[] = [];
  const args: string[] = [`-Uri ${psString(p.url)}`];
  args.push(PS_METHODS.has(p.method) ? `-Method ${p.method.charAt(0)}${p.method.slice(1).toLowerCase()}` : `-CustomMethod ${psString(p.method)}`);
  const headers = p.headers.filter(([k]) => k.toLowerCase() !== 'content-type');
  if (p.basic) {
    if (p.basic.digest) lines.push('# Digest auth: pass -Credential (Get-Credential) instead of the Authorization header.');
    else {
      lines.push(`$credentials = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${psString(`${p.basic.username}:${p.basic.password}`)}))`);
      headers.push(['Authorization', '__BASIC__']);
    }
  }
  if (headers.length) {
    lines.push('$headers = @{');
    for (const [k, v] of headers) lines.push(`    ${psString(k)} = ${v === '__BASIC__' ? '"Basic $credentials"' : psString(v)}`);
    lines.push('}');
    args.push('-Headers $headers');
  }
  if (p.contentType && p.body.kind !== 'multipart') args.push(`-ContentType ${psString(p.contentType)}`);
  switch (p.body.kind) {
    case 'text':
      lines.push(`$body = ${psString(p.body.text)}`);
      args.push('-Body $body');
      break;
    case 'form':
      lines.push('$body = @{');
      for (const [k, v] of p.body.fields) lines.push(`    ${psString(k)} = ${psString(v)}`);
      lines.push('}');
      args.push('-Body $body');
      break;
    case 'multipart':
      lines.push('$form = @{');
      for (const part of p.body.parts) lines.push(`    ${psString(part.name)} = ${part.filePath !== undefined ? `Get-Item -LiteralPath ${psString(part.filePath)}` : psString(part.value ?? '')}`);
      lines.push('}');
      args.push('-Form $form');
      break;
    case 'file':
      args.push(`-InFile ${psString(p.body.filePath)}`);
      break;
    case 'none':
      break;
  }
  if (p.clientCert) lines.push(`# Client certificate: pass -Certificate (Get-PfxCertificate -FilePath ${psString(p.clientCert.cert)}).`);
  if (p.settings.verifyTls === false) {
    lines.push('# WARNING: TLS certificate verification is disabled (-SkipCertificateCheck, PowerShell 7+).');
    args.push('-SkipCertificateCheck');
  }
  if (p.settings.followRedirects === false) args.push('-MaximumRedirection 0');
  else if (p.settings.maxRedirects !== undefined) args.push(`-MaximumRedirection ${p.settings.maxRedirects}`);
  if (p.settings.timeoutMs) args.push(`-TimeoutSec ${Math.max(1, Math.ceil(p.settings.timeoutMs / 1000))}`);
  lines.push(`$response = Invoke-RestMethod ${args.join(' `\n    ')}`);
  lines.push('$response | ConvertTo-Json -Depth 10');
  return lines.join('\n');
}

/** Generate a code snippet for `request` in the given target language. */
export function generateCode(target: CodegenTarget, request: HttpRequest, opts: CodegenOptions = {}): CodegenResult {
  if (!(CODEGEN_TARGETS as readonly string[]).includes(target)) throw new Error(`Unknown code generation target "${String(target)}".`);
  const p = prepareRequest(request, opts);
  let code: string;
  switch (target) {
    case 'curl':
      code = genCurl(p, opts);
      break;
    case 'fetch':
    case 'typescript':
    case 'node':
      code = genFetch(p, target);
      break;
    case 'python':
      code = genPython(p);
      break;
    case 'csharp':
      code = genCSharp(p);
      break;
    case 'powershell':
      code = genPowerShell(p);
      break;
  }
  if (target === 'fetch' && p.body.kind === 'multipart' && p.body.parts.some((x) => x.filePath !== undefined))
    p.warnings.push({ code: 'info', message: 'Browser fetch cannot read local files; replace fileInput with a File object.', field: 'body' });
  return { target, language: LANGUAGES[target], code, warnings: p.warnings };
}
