import {
  createAssertion,
  createEnvironment,
  emptyGroup,
  kv,
  parseEnvironment,
  type AssertionGroup,
  type AssertionOperator,
  type Auth,
  type Extraction,
  type Folder,
  type HttpRequest,
  type KeyValue,
  type MultipartPart,
  type RequestBody,
} from '@reqvyn/core';
import { newId } from '@reqvyn/shared';
import type { ImportFile, ImportResult } from '../types.js';
import { CollectionBuilder, Warnings, asArray, decodeText, importError, isObject, normalizeMethod, nowIso, parseJsonSafe, splitUrl, str, type JsonObject } from '../util.js';

/**
 * Bruno importer: the `.bru` text format (single requests, folder.bru, collection.bru,
 * environments/*.bru), a set of .bru files representing a collection folder, and the Bruno JSON
 * collection export.
 */

// ---------------------------------------------------------------------------------------------
// .bru parser
// ---------------------------------------------------------------------------------------------

export interface BruBlock {
  name: string;
  /** Raw content lines (de-indented by two spaces). */
  lines: string[];
  /** `[` list blocks (e.g. `vars:secret [ a, b ]`). */
  list?: boolean;
}

export function parseBru(text: string): BruBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: BruBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const open = /^([A-Za-z][\w:-]*)\s*([{[])\s*$/.exec(line);
    const inline = /^([A-Za-z][\w:-]*)\s*\{\s*\}\s*$/.exec(line);
    if (inline) {
      blocks.push({ name: inline[1] ?? '', lines: [] });
      i++;
      continue;
    }
    if (!open) {
      i++;
      continue;
    }
    const close = open[2] === '[' ? ']' : '}';
    const body: string[] = [];
    i++;
    while (i < lines.length && (lines[i] ?? '') !== close && (lines[i] ?? '').trimEnd() !== close) {
      body.push((lines[i] ?? '').replace(/^ {2}/, ''));
      i++;
    }
    i++;
    blocks.push({ name: open[1] ?? '', lines: body, ...(open[2] === '[' ? { list: true } : {}) });
  }
  return blocks;
}

export function bruDict(block: BruBlock | undefined): Array<{ key: string; value: string; enabled: boolean }> {
  if (!block) return [];
  const out: Array<{ key: string; value: string; enabled: boolean }> = [];
  for (const raw of block.lines) {
    const line = raw.trim();
    if (!line) continue;
    const enabled = !line.startsWith('~');
    const l = enabled ? line : line.slice(1);
    const idx = l.indexOf(':');
    if (idx < 0) {
      out.push({ key: l.trim(), value: '', enabled });
      continue;
    }
    let key = l.slice(0, idx).trim();
    if (/^".*"$/.test(key) || /^'.*'$/.test(key)) key = key.slice(1, -1);
    out.push({ key, value: l.slice(idx + 1).trim(), enabled });
  }
  return out;
}

function bruText(block: BruBlock | undefined): string {
  if (!block) return '';
  const lines = [...block.lines];
  while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();
  return lines.join('\n');
}

function bruList(block: BruBlock | undefined): string[] {
  if (!block) return [];
  return block.lines
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const HTTP_BLOCKS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'connect', 'trace'];

const ASSERT_OPS: Record<string, AssertionOperator> = {
  eq: 'eq',
  neq: 'neq',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
  contains: 'contains',
  notContains: 'notContains',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
  matches: 'matches',
  length: 'lengthEq',
  isJson: 'isJson',
  isDefined: 'exists',
  isUndefined: 'notExists',
  isNull: 'eq',
  isNumber: 'isType',
  isString: 'isType',
  isBoolean: 'isType',
  isArray: 'isType',
};

function convertAssertion(key: string, value: string, enabled: boolean, w: Warnings, loc: string): ReturnType<typeof createAssertion> | undefined {
  const m = /^(\S+)\s*(.*)$/.exec(value.trim());
  const opName = m?.[1] ?? '';
  let expected = (m?.[2] ?? '').trim();
  const operator = ASSERT_OPS[opName];
  if (!operator) {
    w.add('unsupported-feature', `Assertion operator "${opName}" (${key}) is not supported.`, loc, 'assert');
    return undefined;
  }
  if (opName === 'isNull') expected = 'null';
  if (operator === 'isType') expected = opName.slice(2).toLowerCase();
  if (/^".*"$/.test(expected)) expected = expected.slice(1, -1);
  const k = key.trim();
  if (k === 'res.status') return createAssertion({ source: 'status', operator, expected, enabled });
  if (k === 'res.responseTime') return createAssertion({ source: 'responseTime', operator, expected, enabled });
  if (k === 'res.body') return createAssertion({ source: operator === 'isJson' ? 'body' : 'json', path: '$', operator, expected, enabled });
  if (k.startsWith('res.body')) return createAssertion({ source: 'json', path: `$${k.slice(8)}`, operator, expected, enabled });
  if (k.startsWith('res.headers.')) {
    const name = k.slice(12).replace(/^\[["']|["']\]$/g, '');
    if (name.toLowerCase() === 'content-type') return createAssertion({ source: 'contentType', operator, expected, enabled });
    return createAssertion({ source: 'header', path: name, operator, expected, enabled });
  }
  w.add('unsupported-feature', `Assertion target "${k}" is not supported.`, loc, 'assert');
  return undefined;
}

function convertBruAuth(mode: string, blocks: BruBlock[], w: Warnings, loc: string): Auth {
  const get = (n: string) => blocks.find((b) => b.name === n);
  const dict = (n: string) => Object.fromEntries(bruDict(get(n)).map((e) => [e.key, e.value]));
  switch (mode) {
    case '':
    case 'inherit':
      return { type: 'inherit' };
    case 'none':
      return { type: 'none' };
    case 'basic': {
      const d = dict('auth:basic');
      return { type: 'basic', username: d.username ?? '', password: d.password ?? '' };
    }
    case 'digest': {
      const d = dict('auth:digest');
      return { type: 'digest', username: d.username ?? '', password: d.password ?? '' };
    }
    case 'bearer':
      return { type: 'bearer', token: dict('auth:bearer').token ?? '', prefix: 'Bearer' };
    case 'apikey': {
      const d = dict('auth:apikey');
      return { type: 'apikey', key: d.key ?? '', value: d.value ?? '', in: d.placement === 'queryparams' || d.placement === 'query' ? 'query' : 'header' };
    }
    case 'awsv4': {
      const d = dict('auth:awsv4');
      if (d.profileName) w.add('unsupported-field', 'AWS profile names are not supported.', loc, 'auth:awsv4.profileName');
      return {
        type: 'awsv4',
        accessKeyId: d.accessKeyId ?? '',
        secretAccessKey: d.secretAccessKey ?? '',
        sessionToken: d.sessionToken ?? '',
        region: d.region || 'us-east-1',
        service: d.service || 'execute-api',
      };
    }
    case 'oauth2': {
      const d = dict('auth:oauth2');
      const g = d.grant_type ?? 'authorization_code';
      return {
        type: 'oauth2',
        grantType: g === 'client_credentials' ? 'client_credentials' : g === 'password' ? 'password' : 'authorization_code',
        authUrl: d.authorization_url ?? '',
        tokenUrl: d.access_token_url ?? '',
        deviceAuthUrl: '',
        clientId: d.client_id ?? '',
        clientSecret: d.client_secret ?? '',
        username: d.username ?? '',
        password: d.password ?? '',
        scope: d.scope ?? '',
        audience: '',
        redirectUri: d.callback_url || 'http://127.0.0.1:0/callback',
        usePkce: d.pkce === 'true',
        clientAuthentication: 'body',
        tokenPrefix: 'Bearer',
        autoRefresh: true,
        extraParams: [],
      };
    }
    default:
      w.add('unsupported-feature', `Bruno auth mode "${mode}" is not supported; auth set to none.`, loc, 'auth');
      return { type: 'none' };
  }
}

function scriptsFrom(blocks: BruBlock[], w: Warnings, loc: string): { pre: string; post: string } {
  const pre = bruText(blocks.find((b) => b.name === 'script:pre-request'));
  let post = bruText(blocks.find((b) => b.name === 'script:post-response'));
  const tests = bruText(blocks.find((b) => b.name === 'tests'));
  if (tests) {
    post = post ? `${post}\n\n// --- Bruno tests\n${tests}` : `// --- Bruno tests\n${tests}`;
    w.add('converted', 'Bruno "tests" script was appended to the post-response script.', loc, 'tests');
  }
  if (/\b(bru|req|res)\./.test(pre + post)) w.add('script-needs-adaptation', 'Scripts use the Bruno "bru/req/res" API and were imported as-is.', loc, 'script');
  return { pre, post };
}

function extractionsFrom(entries: Array<{ key: string; value: string; enabled: boolean }>, w: Warnings, loc: string): Extraction[] {
  const out: Extraction[] = [];
  for (const e of entries) {
    const v = e.value.trim();
    if (v.startsWith('res.body')) out.push({ id: newId(), enabled: e.enabled, variable: e.key, source: 'json', path: `$${v.slice(8)}`, scope: 'runtime' });
    else if (v.startsWith('res.headers.')) out.push({ id: newId(), enabled: e.enabled, variable: e.key, source: 'header', path: v.slice(12), scope: 'runtime' });
    else if (v === 'res.status') out.push({ id: newId(), enabled: e.enabled, variable: e.key, source: 'status', path: '', scope: 'runtime' });
    else w.add('unsupported-feature', `Post-response variable "${e.key}" uses an expression (${v}) that is not supported.`, loc, 'vars:post-response');
  }
  return out;
}

/** Convert one parsed .bru request file into request fields. */
export function bruToRequest(blocks: BruBlock[], w: Warnings, fallbackName: string): Partial<HttpRequest> & { seq?: number } {
  const meta = Object.fromEntries(bruDict(blocks.find((b) => b.name === 'meta')).map((e) => [e.key, e.value]));
  const name = meta.name || fallbackName;
  const loc = name;
  const methodBlock = blocks.find((b) => HTTP_BLOCKS.includes(b.name));
  const http = Object.fromEntries(bruDict(methodBlock).map((e) => [e.key, e.value]));
  if (meta.type && meta.type !== 'http' && meta.type !== 'graphql')
    w.add('unsupported-feature', `Bruno request type "${meta.type}" is not supported; imported as HTTP.`, loc, 'meta.type');

  const { base, params: urlParams } = splitUrl(http.url ?? '');
  const query = bruDict(blocks.find((b) => b.name === 'params:query' || b.name === 'query'));
  const path = bruDict(blocks.find((b) => b.name === 'params:path'));
  const url = base.replace(/(^|\/):([A-Za-z_][\w-]*)/g, (_m, pre: string, n: string) => `${pre}{{${n}}}`);
  const params = query.length ? query.map((q) => kv(q.key, q.value, { enabled: q.enabled })) : urlParams;

  const bodyMode = http.body ?? 'none';
  const byName = (n: string) => blocks.find((b) => b.name === n);
  let body: RequestBody = { mode: 'none' };
  switch (bodyMode) {
    case 'json':
      body = { mode: 'json', text: bruText(byName('body:json')) };
      break;
    case 'xml':
      body = { mode: 'xml', text: bruText(byName('body:xml')) };
      break;
    case 'text':
      body = { mode: 'text', text: bruText(byName('body:text')) };
      break;
    case 'graphql':
      body = { mode: 'graphql', query: bruText(byName('body:graphql')), variables: bruText(byName('body:graphql:vars')) };
      break;
    case 'formUrlEncoded':
    case 'form-urlencoded':
      body = { mode: 'urlencoded', fields: bruDict(byName('body:form-urlencoded')).map((e) => kv(e.key, e.value, { enabled: e.enabled })) };
      break;
    case 'multipartForm':
    case 'multipart-form':
      body = {
        mode: 'multipart',
        parts: bruDict(byName('body:multipart-form')).map((e): MultipartPart => {
          const file = /^@file\((.*)\)$/.exec(e.value);
          return file
            ? { id: newId(), key: e.key, enabled: e.enabled, type: 'file', value: '', filePath: (file[1] ?? '').split('|')[0] ?? '' }
            : { id: newId(), key: e.key, enabled: e.enabled, type: 'text', value: e.value };
        }),
      };
      break;
    case 'none':
      break;
    default:
      w.add('unsupported-feature', `Body mode "${bodyMode}" is not supported.`, loc, 'body');
  }

  const assertions: AssertionGroup = emptyGroup();
  for (const e of bruDict(byName('assert'))) {
    const a = convertAssertion(e.key, e.value, e.enabled, w, loc);
    if (a) assertions.items.push(a);
  }
  const settingsBlock = Object.fromEntries(bruDict(byName('settings')).map((e) => [e.key, e.value]));
  const known = new Set(['meta', 'params:query', 'query', 'params:path', 'headers', 'assert', 'settings', 'docs', 'tests', 'vars:pre-request', 'vars:post-response', 'script:pre-request', 'script:post-response', ...HTTP_BLOCKS]);
  for (const b of blocks) {
    if (known.has(b.name) || b.name.startsWith('auth:') || b.name.startsWith('body:')) continue;
    w.add('unsupported-field', `Block "${b.name}" is not supported.`, loc, b.name);
  }
  const seq = Number(meta.seq);
  return {
    name,
    method: normalizeMethod(methodBlock?.name ?? 'get'),
    url,
    params,
    headers: bruDict(byName('headers')).map((h) => kv(h.key, h.value, { enabled: h.enabled })),
    body,
    auth: convertBruAuth(http.auth ?? 'inherit', blocks, w, loc),
    variables: [
      ...path.map((p) => kv(p.key, p.value, { enabled: p.enabled })),
      ...bruDict(byName('vars:pre-request')).map((v) => kv(v.key, v.value, { enabled: v.enabled })),
    ],
    extractions: extractionsFrom(bruDict(byName('vars:post-response')), w, loc),
    scripts: scriptsFrom(blocks, w, loc),
    tests: assertions,
    docs: bruText(byName('docs')),
    settings: settingsBlock.encodeUrl !== undefined ? { encodeUrl: settingsBlock.encodeUrl === 'true' } : {},
    ...(Number.isFinite(seq) ? { seq } : {}),
  };
}

export function looksLikeBru(text: string): boolean {
  return /^meta\s*\{/m.test(text) || new RegExp(`^(${HTTP_BLOCKS.join('|')})\\s*\\{\\s*$`, 'm').test(text) || /^vars(:secret)?\s*[{[]/m.test(text);
}

function bruEnvironment(name: string, text: string): ReturnType<typeof parseEnvironment> {
  const blocks = parseBru(text);
  const secrets = bruList(blocks.find((b) => b.name === 'vars:secret'));
  const variables: KeyValue[] = [
    ...bruDict(blocks.find((b) => b.name === 'vars')).map((v) => kv(v.key, v.value, { enabled: v.enabled })),
    ...secrets.map((s) => (s.startsWith('~') ? kv(s.slice(1), '', { secret: true, enabled: false }) : kv(s, '', { secret: true }))),
  ];
  return parseEnvironment(createEnvironment({ name, variables }));
}

/** Import a single .bru request file as a one-request collection. */
export function importBruFile(text: string, fileName = 'request.bru'): ImportResult {
  return importBrunoFiles([{ name: fileName, content: text }]);
}

/**
 * Import a Bruno collection folder given as a list of files (paths relative to anywhere; the
 * directory containing `bruno.json` is used as the collection root when present).
 */
export function importBrunoFiles(files: ImportFile[]): ImportResult {
  const w = new Warnings('bruno');
  const norm = files.map((f) => ({ path: f.name.replace(/\\/g, '/').replace(/^\.\//, ''), text: decodeText(f.content) }));
  const config = norm.find((f) => f.path === 'bruno.json' || f.path.endsWith('/bruno.json'));
  let root = config ? config.path.slice(0, -'bruno.json'.length) : '';
  if (!config) {
    // Common directory prefix of all files.
    const dirs = norm.map((f) => f.path.split('/').slice(0, -1));
    const first = dirs[0] ?? [];
    let n = 0;
    while (n < first.length && dirs.every((d) => d[n] === first[n])) n++;
    root = first.slice(0, n).join('/');
    if (root) root += '/';
  }
  const rel = norm.filter((f) => f.path.startsWith(root)).map((f) => ({ ...f, rel: f.path.slice(root.length) }));
  const cfg = config ? parseJsonSafe(config.text) : undefined;
  const single = rel.filter((f) => f.rel.endsWith('.bru')).length === 1 && !config;
  const result: ImportResult = { collections: [], environments: [], warnings: w.list };

  let collectionName = isObject(cfg) && cfg.name ? str(cfg.name) : root.split('/').filter(Boolean).pop() ?? 'Bruno Collection';
  if (single) collectionName = 'Bruno Import';
  const b = new CollectionBuilder({
    name: collectionName,
    meta: { source: { type: 'bruno', importedAt: nowIso() } },
  });
  if (isObject(cfg)) {
    w.unknownKeys(cfg, ['version', 'name', 'type', 'ignore', 'scripts', 'presets', 'size', 'filesCount'], collectionName, 'bruno.json.');
  }

  const folderMap = new Map<string, Folder>();
  const ensureFolder = (dir: string): string | null => {
    if (!dir) return null;
    const existing = folderMap.get(dir);
    if (existing) return existing.id;
    const parts = dir.split('/');
    const parentId = ensureFolder(parts.slice(0, -1).join('/'));
    const folder = b.addFolder({ parentId, name: parts[parts.length - 1] ?? dir });
    folderMap.set(dir, folder);
    return folder.id;
  };

  const requests: Array<{ dir: string; seq: number; data: Partial<HttpRequest> }> = [];
  for (const f of rel.sort((a, c) => a.rel.localeCompare(c.rel))) {
    const dir = f.rel.split('/').slice(0, -1).join('/');
    const base = f.rel.split('/').pop() ?? f.rel;
    if (f === config || f.rel === 'bruno.json') continue;
    if (f.rel.startsWith('environments/') && base.endsWith('.bru')) {
      result.environments.push(bruEnvironment(base.replace(/\.bru$/, ''), f.text));
      continue;
    }
    if (!base.endsWith('.bru')) {
      if (base !== '.env' && base !== '.gitignore') w.add('unknown-file', `File "${f.path}" is not a Bruno file and was ignored.`, f.path);
      else if (base === '.env') w.add('secret', 'Bruno ".env" file was not imported (secrets must be re-entered).', f.path);
      continue;
    }
    const blocks = parseBru(f.text);
    if (base === 'collection.bru' || base === 'folder.bru') {
      let target: Folder | typeof b.collection | undefined = b.collection;
      if (base === 'folder.bru') {
        const folderId = ensureFolder(dir);
        target = b.collection.folders.find((x) => x.id === folderId);
      }
      if (!target) continue;
      const meta = Object.fromEntries(bruDict(blocks.find((x) => x.name === 'meta')).map((e) => [e.key, e.value]));
      if (meta.name && 'parentId' in target) target.name = meta.name;
      target.headers = bruDict(blocks.find((x) => x.name === 'headers')).map((h) => kv(h.key, h.value, { enabled: h.enabled }));
      const authMode = Object.fromEntries(bruDict(blocks.find((x) => x.name === 'auth')).map((e) => [e.key, e.value])).mode;
      if (authMode) target.auth = convertBruAuth(authMode, blocks, w, f.rel);
      target.scripts = scriptsFrom(blocks, w, f.rel);
      target.variables = bruDict(blocks.find((x) => x.name === 'vars:pre-request')).map((v) => kv(v.key, v.value, { enabled: v.enabled }));
      const docs = bruText(blocks.find((x) => x.name === 'docs'));
      if (docs) target.description = docs;
      if (target === b.collection && target.auth.type === 'inherit') target.auth = { type: 'none' };
      continue;
    }
    const data = bruToRequest(blocks, w, base.replace(/\.bru$/, ''));
    const { seq, ...rest } = data;
    requests.push({ dir, seq: seq ?? 0, data: rest });
  }
  requests.sort((a, c) => a.dir.localeCompare(c.dir) || a.seq - c.seq);
  for (const r of requests) b.addRequest({ ...r.data, parentId: ensureFolder(r.dir) });
  if (requests.length || !result.environments.length) result.collections.push(b.build());
  return result;
}

// ---------------------------------------------------------------------------------------------
// Bruno JSON collection export
// ---------------------------------------------------------------------------------------------

export function isBrunoJson(doc: unknown): boolean {
  return isObject(doc) && Array.isArray(doc.items) && typeof doc.name === 'string' && ('uid' in doc || 'brunoConfig' in doc || doc.version === '1') && !('schemaVersion' in doc);
}

function jsonAuth(a: unknown, w: Warnings, loc: string): Auth {
  if (!isObject(a)) return { type: 'inherit' };
  const mode = str(a.mode);
  const sub = (k: string) => (isObject(a[k]) ? (a[k] as JsonObject) : {});
  const blocks: BruBlock[] = [];
  const toBlock = (name: string, obj: JsonObject, rename: Record<string, string> = {}) =>
    blocks.push({ name, lines: Object.entries(obj).map(([k, v]) => `${rename[k] ?? k}: ${str(v)}`) });
  if (mode === 'basic') toBlock('auth:basic', sub('basic'));
  if (mode === 'digest') toBlock('auth:digest', sub('digest'));
  if (mode === 'bearer') toBlock('auth:bearer', sub('bearer'));
  if (mode === 'apikey') toBlock('auth:apikey', sub('apikey'));
  if (mode === 'awsv4') toBlock('auth:awsv4', sub('awsv4'));
  if (mode === 'oauth2')
    toBlock('auth:oauth2', sub('oauth2'), {
      grantType: 'grant_type',
      authorizationUrl: 'authorization_url',
      accessTokenUrl: 'access_token_url',
      clientId: 'client_id',
      clientSecret: 'client_secret',
      callbackUrl: 'callback_url',
    });
  return convertBruAuth(mode, blocks, w, loc);
}

export function importBrunoJson(doc: unknown, fileName?: string): ImportResult {
  if (!isBrunoJson(doc) || !isObject(doc)) throw importError('Not a Bruno JSON collection.');
  const w = new Warnings('bruno-json');
  const name = str(doc.name) || 'Bruno Collection';
  const root = isObject(doc.root) ? doc.root : {};
  const rootReq = isObject(root.request) ? root.request : {};
  const b = new CollectionBuilder({
    name,
    meta: { source: { type: 'bruno', ...(fileName ? { location: fileName } : {}), importedAt: nowIso() } },
  });
  const nv = (list: unknown) =>
    asArray(list)
      .filter(isObject)
      .map((h) => kv(str(h.name), str(h.value), { enabled: h.enabled !== false }));
  b.collection.headers = nv(rootReq.headers);
  const rootAuth = jsonAuth(rootReq.auth, w, name);
  b.collection.auth = rootAuth.type === 'inherit' ? { type: 'none' } : rootAuth;
  const jsonScripts = (s: unknown, tests: unknown, loc: string) => {
    const o = isObject(s) ? s : {};
    const blocks: BruBlock[] = [];
    if (o.req) blocks.push({ name: 'script:pre-request', lines: str(o.req).split('\n') });
    if (o.res) blocks.push({ name: 'script:post-response', lines: str(o.res).split('\n') });
    if (tests) blocks.push({ name: 'tests', lines: str(tests).split('\n') });
    return scriptsFrom(blocks, w, loc);
  };
  b.collection.scripts = jsonScripts(rootReq.script, rootReq.tests, name);
  if (root.docs) b.collection.description = str(root.docs);

  const walk = (items: unknown, parentId: string | null, path: string) => {
    const sorted = asArray(items)
      .filter(isObject)
      .sort((a, c) => Number(a.seq ?? 0) - Number(c.seq ?? 0));
    for (const it of sorted) {
      const itemName = str(it.name) || 'Untitled';
      const loc = `${path} / ${itemName}`;
      if (it.type === 'folder') {
        const froot = isObject(it.root) ? it.root : {};
        const freq = isObject(froot.request) ? froot.request : {};
        const folder = b.addFolder({
          parentId,
          name: itemName,
          headers: nv(freq.headers),
          auth: jsonAuth(freq.auth, w, loc),
          scripts: jsonScripts(freq.script, freq.tests, loc),
        });
        walk(it.items, folder.id, loc);
        continue;
      }
      if (it.type !== 'http-request' && it.type !== 'graphql-request') {
        w.add('unsupported-feature', `Bruno item type "${str(it.type)}" is not supported.`, loc, 'type');
        continue;
      }
      const r = isObject(it.request) ? it.request : {};
      const body = isObject(r.body) ? r.body : {};
      const mode = str(body.mode) || 'none';
      let reqBody: RequestBody = { mode: 'none' };
      if (mode === 'json') reqBody = { mode: 'json', text: str(body.json) };
      else if (mode === 'xml') reqBody = { mode: 'xml', text: str(body.xml) };
      else if (mode === 'text') reqBody = { mode: 'text', text: str(body.text) };
      else if (mode === 'formUrlEncoded') reqBody = { mode: 'urlencoded', fields: nv(body.formUrlEncoded) };
      else if (mode === 'multipartForm')
        reqBody = {
          mode: 'multipart',
          parts: asArray(body.multipartForm)
            .filter(isObject)
            .map((p): MultipartPart => {
              const isFile = p.type === 'file';
              const val = Array.isArray(p.value) ? str(p.value[0]) : str(p.value);
              return isFile
                ? { id: newId(), key: str(p.name), enabled: p.enabled !== false, type: 'file', value: '', filePath: val }
                : { id: newId(), key: str(p.name), enabled: p.enabled !== false, type: 'text', value: val };
            }),
        };
      else if (mode === 'graphql') {
        const g = isObject(body.graphql) ? body.graphql : {};
        reqBody = { mode: 'graphql', query: str(g.query), variables: str(g.variables) };
      } else if (mode !== 'none') w.add('unsupported-feature', `Body mode "${mode}" is not supported.`, loc, 'body.mode');
      const params = asArray(r.params).filter(isObject);
      const { base, params: urlParams } = splitUrl(str(r.url));
      const query = params.filter((p) => p.type !== 'path').map((p) => kv(str(p.name), str(p.value), { enabled: p.enabled !== false }));
      const vars = isObject(r.vars) ? r.vars : {};
      const assertions = emptyGroup();
      for (const a of asArray(r.assertions).filter(isObject)) {
        const conv = convertAssertion(str(a.name), str(a.value), a.enabled !== false, w, loc);
        if (conv) assertions.items.push(conv);
      }
      b.addRequest({
        parentId,
        name: itemName,
        method: normalizeMethod(r.method),
        url: base.replace(/(^|\/):([A-Za-z_][\w-]*)/g, (_m, pre: string, n: string) => `${pre}{{${n}}}`),
        params: query.length ? query : urlParams,
        headers: nv(r.headers),
        body: reqBody,
        auth: jsonAuth(r.auth, w, loc),
        variables: [
          ...params.filter((p) => p.type === 'path').map((p) => kv(str(p.name), str(p.value), { enabled: p.enabled !== false })),
          ...nv(vars.req),
        ],
        extractions: extractionsFrom(
          asArray(vars.res)
            .filter(isObject)
            .map((v) => ({ key: str(v.name), value: str(v.value), enabled: v.enabled !== false })),
          w,
          loc,
        ),
        scripts: jsonScripts(r.script, r.tests, loc),
        tests: assertions,
        docs: str(r.docs),
      });
    }
  };
  walk(doc.items, null, name);
  const environments = asArray(doc.environments)
    .filter(isObject)
    .map((e) =>
      parseEnvironment(
        createEnvironment({
          name: str(e.name) || 'Environment',
          variables: asArray(e.variables)
            .filter(isObject)
            .map((v) => kv(str(v.name), v.secret ? '' : str(v.value), { enabled: v.enabled !== false, ...(v.secret ? { secret: true } : {}) })),
        }),
      ),
    );
  return { collections: [b.build()], environments, warnings: w.list };
}
