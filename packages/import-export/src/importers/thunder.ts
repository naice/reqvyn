import {
  createAssertion,
  createEnvironment,
  emptyGroup,
  kv,
  parseEnvironment,
  type Assertion,
  type AssertionGroup,
  type AssertionOperator,
  type AssertionSource,
  type Auth,
  type Extraction,
  type KeyValue,
  type RequestBody,
} from '@reqvyn/core';
import { newId } from '@reqvyn/shared';
import type { ImportResult } from '../types.js';
import { CollectionBuilder, Warnings, asArray, importError, isObject, normalizeMethod, nowIso, splitUrl, str, type JsonObject } from '../util.js';

/**
 * Thunder Client collection / environment export importer. Written against the public JSON export
 * shape (`client: "Thunder Client"`); no Thunder Client code is used.
 */

export function isThunderCollection(doc: unknown): boolean {
  return isObject(doc) && (doc.client === 'Thunder Client' || 'collectionName' in doc) && Array.isArray(doc.requests);
}

export function isThunderEnvironment(doc: unknown): boolean {
  return isObject(doc) && (doc.client === 'Thunder Client' || 'environmentName' in doc) && Array.isArray(doc.variables) && !Array.isArray(doc.requests);
}

function nameValues(list: unknown, field: string, w: Warnings, location: string): KeyValue[] {
  return asArray(list)
    .filter(isObject)
    .filter((h) => str(h.name) || str(h.value))
    .map((h) => {
      if (h.isPath) w.add('converted', `Path parameter "${str(h.name)}" became a request variable.`, location, field);
      return kv(str(h.name), str(h.value), { enabled: h.isDisabled !== true });
    });
}

function convertAuth(auth: unknown, w: Warnings, location: string): Auth | undefined {
  if (!isObject(auth)) return undefined;
  const t = str(auth.type);
  switch (t) {
    case '':
    case 'inherit':
      return { type: 'inherit' };
    case 'none':
      return { type: 'none' };
    case 'basic': {
      const b = isObject(auth.basic) ? auth.basic : {};
      return { type: 'basic', username: str(b.username), password: str(b.password) };
    }
    case 'bearer':
      return { type: 'bearer', token: str(auth.bearer), prefix: str(auth.bearerPrefix) || 'Bearer' };
    case 'apikey': {
      const a = isObject(auth.apikey) ? auth.apikey : {};
      return { type: 'apikey', key: str(a.key), value: str(a.value), in: a.in === 'query' ? 'query' : 'header' };
    }
    case 'oauth2': {
      const o = isObject(auth.oauth2) ? auth.oauth2 : {};
      const grant = str(o.grantType);
      const grantType = grant === 'client_credentials' ? 'client_credentials' : grant === 'password' ? 'password' : 'authorization_code';
      if (grant && !['client_credentials', 'password', 'authorization_code', 'authorization_code_pkce'].includes(grant))
        w.add('converted', `OAuth 2.0 grant "${grant}" mapped to authorization_code.`, location, 'auth.oauth2.grantType');
      return {
        type: 'oauth2',
        grantType,
        authUrl: str(o.authUrl),
        tokenUrl: str(o.tokenUrl),
        deviceAuthUrl: '',
        clientId: str(o.clientId),
        clientSecret: str(o.clientSecret),
        username: str(o.username),
        password: str(o.password),
        scope: str(o.scope),
        audience: str(o.audience),
        redirectUri: str(o.callbackUrl) || 'http://127.0.0.1:0/callback',
        usePkce: grant === 'authorization_code_pkce',
        clientAuthentication: o.clientAuth === 'in-header' ? 'basic' : 'body',
        tokenPrefix: str(o.tokenPrefix) || 'Bearer',
        autoRefresh: true,
        extraParams: [],
      };
    }
    case 'aws': {
      const a = isObject(auth.aws) ? auth.aws : {};
      return {
        type: 'awsv4',
        accessKeyId: str(a.accessKeyId),
        secretAccessKey: str(a.secretKey),
        sessionToken: str(a.sessionToken),
        region: str(a.region) || 'us-east-1',
        service: str(a.service) || 'execute-api',
      };
    }
    case 'ntlm':
    default:
      w.add('unsupported-feature', `Thunder Client auth type "${t}" is not supported; auth set to none.`, location, 'auth.type');
      return { type: 'none' };
  }
}

function convertBody(body: unknown, w: Warnings, location: string): RequestBody {
  if (!isObject(body)) return { mode: 'none' };
  const t = str(body.type);
  switch (t) {
    case '':
    case 'none':
      return { mode: 'none' };
    case 'json':
      return { mode: 'json', text: str(body.raw) };
    case 'xml':
      return { mode: 'xml', text: str(body.raw) };
    case 'text':
      return { mode: 'text', text: str(body.raw) };
    case 'formencoded':
      return { mode: 'urlencoded', fields: nameValues(body.form, 'body.form', w, location) };
    case 'formdata':
      return {
        mode: 'multipart',
        parts: [
          ...asArray(body.form)
            .filter(isObject)
            .map((f) => ({ id: newId(), key: str(f.name), value: str(f.value), enabled: f.isDisabled !== true, type: 'text' as const })),
          ...asArray(body.files)
            .filter(isObject)
            .map((f) => ({ id: newId(), key: str(f.name), value: '', filePath: str(f.value), enabled: f.isDisabled !== true, type: 'file' as const })),
        ],
      };
    case 'graphql': {
      const g = isObject(body.graphql) ? body.graphql : {};
      return { mode: 'graphql', query: str(g.query), variables: str(g.variables) };
    }
    case 'binary':
      return { mode: 'binary', filePath: str(body.binary) };
    default:
      w.add('unsupported-feature', `Body type "${t}" is not supported.`, location, 'body.type');
      return { mode: 'none' };
  }
}

const SOURCE_MAP: Record<string, AssertionSource> = {
  'res-code': 'status',
  'res-time': 'responseTime',
  'res-body': 'body',
  'json-query': 'json',
  'Content-Type': 'contentType',
  'Content-Length': 'size',
  'custom-header': 'header',
  'res-cookie': 'cookie',
};

const ACTION_MAP: Record<string, AssertionOperator> = {
  equal: 'eq',
  '==': 'eq',
  notequal: 'neq',
  '!=': 'neq',
  contains: 'contains',
  notcontains: 'notContains',
  '<': 'lt',
  '<=': 'lte',
  '>': 'gt',
  '>=': 'gte',
  istype: 'isType',
  count: 'lengthEq',
  isjson: 'isJson',
  regex: 'matches',
  startswith: 'startsWith',
  endswith: 'endsWith',
  exists: 'exists',
  notexists: 'notExists',
  arraycontains: 'arrayContains',
};

/** `json.data[0].id` -> `$.data[0].id` */
export function thunderJsonPathToJsonPath(p: string): string {
  const s = p.trim();
  if (s.startsWith('$')) return s;
  if (s === 'json') return '$';
  if (s.startsWith('json.')) return `$.${s.slice(5)}`;
  if (s.startsWith('json[')) return `$${s.slice(4)}`;
  return s.startsWith('[') ? `$${s}` : `$.${s}`;
}

function convertTests(tests: unknown, w: Warnings, location: string): { group: AssertionGroup; extractions: Extraction[] } {
  const group = emptyGroup();
  const extractions: Extraction[] = [];
  for (const t of asArray(tests)) {
    if (!isObject(t)) continue;
    const type = str(t.type);
    const action = str(t.action);
    if (type === 'set-env-var' || action === 'setto') {
      const variable = str(t.value).replace(/^\{\{\s*|\s*\}\}$/g, '');
      const custom = str(t.custom);
      let source: Extraction['source'] = 'json';
      let path = thunderJsonPathToJsonPath(custom);
      if (custom.startsWith('header.')) {
        source = 'header';
        path = custom.slice(7);
      } else if (custom.startsWith('cookie.')) {
        source = 'cookie';
        path = custom.slice(7);
      }
      extractions.push({ id: newId(), enabled: t.disabled !== true, variable, source, path, scope: 'environment' });
      continue;
    }
    const source = SOURCE_MAP[type];
    const operator = ACTION_MAP[action];
    if (!source || !operator) {
      w.add('unsupported-feature', `Test "${type} ${action}" is not supported and was not imported.`, location, 'tests');
      continue;
    }
    const path = source === 'json' ? thunderJsonPathToJsonPath(str(t.custom)) : source === 'header' || source === 'cookie' ? str(t.custom) : '';
    const a: Assertion = createAssertion({ source, operator, path, expected: str(t.value), enabled: t.disabled !== true });
    group.items.push(a);
  }
  return { group, extractions };
}

export function importThunderCollection(doc: unknown, fileName?: string): ImportResult {
  if (!isThunderCollection(doc) || !isObject(doc)) throw importError('Not a Thunder Client collection export.');
  const w = new Warnings('thunder');
  const name = str(doc.collectionName) || str(doc.name) || 'Thunder Client Collection';
  const settings = isObject(doc.settings) ? doc.settings : {};
  const colTests = convertTests(settings.tests, w, name);
  const b = new CollectionBuilder({
    name,
    headers: nameValues(settings.headers, 'settings.headers', w, name),
    auth: convertAuth(settings.auth, w, name) ?? { type: 'none' },
    tests: colTests.group,
    meta: { source: { type: 'thunder', ...(fileName ? { location: fileName } : {}), importedAt: nowIso() } },
  });
  if (b.collection.auth.type === 'inherit') b.collection.auth = { type: 'none' };
  if (colTests.extractions.length) w.add('unsupported-field', 'Collection-level set-env-var tests are not supported.', name, 'settings.tests');
  if (isObject(settings.options) && Object.keys(settings.options).length)
    w.add('unsupported-field', 'Collection run options were not imported.', name, 'settings.options');
  for (const k of ['preReq', 'postReq', 'scripts', 'envId']) if (settings[k]) w.add('unsupported-field', `Collection setting "${k}" was not imported.`, name, `settings.${k}`);

  // Folders reference their parent via containerId (empty = root). Create in dependency order.
  const folders = asArray(doc.folders).filter(isObject);
  const idMap = new Map<string, string>();
  const sorted = [...folders].sort((a, b2) => Number(a.sortNum ?? 0) - Number(b2.sortNum ?? 0));
  const pending = new Set(sorted);
  let progress = true;
  while (pending.size && progress) {
    progress = false;
    for (const f of [...pending]) {
      const parent = str(f.containerId);
      if (parent && !idMap.has(parent) && folders.some((x) => str(x._id) === parent)) continue;
      const loc = `${name} / ${str(f.name)}`;
      const fs = isObject(f.settings) ? f.settings : {};
      const tests = convertTests(fs.tests, w, loc);
      const folder = b.addFolder({
        parentId: parent ? idMap.get(parent) ?? null : null,
        name: str(f.name) || 'Folder',
        headers: nameValues(fs.headers, 'settings.headers', w, loc),
        auth: convertAuth(fs.auth, w, loc) ?? { type: 'inherit' },
        tests: tests.group,
      });
      idMap.set(str(f._id), folder.id);
      pending.delete(f);
      progress = true;
    }
  }
  if (pending.size) w.add('converted', `${pending.size} folder(s) with circular parents were placed at the root.`, name);
  for (const f of pending) {
    const folder = b.addFolder({ parentId: null, name: str(f.name) || 'Folder' });
    idMap.set(str(f._id), folder.id);
  }

  const requests = asArray(doc.requests)
    .filter(isObject)
    .sort((a, b2) => Number(a.sortNum ?? 0) - Number(b2.sortNum ?? 0));
  for (const r of requests) {
    const loc = `${name} / ${str(r.name)}`;
    const { base, params: urlParams } = splitUrl(str(r.url));
    const allParams = asArray(r.params).filter(isObject);
    const query = nameValues(allParams.filter((p) => !p.isPath), 'params', w, loc);
    const pathVars = nameValues(allParams.filter((p) => p.isPath), 'params', w, loc);
    const tests = convertTests(r.tests, w, loc);
    const reqSettings = isObject(r.reqSettings) ? r.reqSettings : {};
    const pre = str(r.preReq ?? '');
    const post = str(r.postReq ?? '');
    if (/\btc\./.test(pre + post)) w.add('script-needs-adaptation', 'Scripts use the Thunder Client "tc.*" API and were imported as-is.', loc, 'scripts');
    for (const k of ['preReq', 'postReq']) if (isObject(r[k]) || Array.isArray(r[k])) w.add('unsupported-field', `Structured ${k} is not supported.`, loc, k);
    b.addRequest({
      parentId: str(r.containerId) ? idMap.get(str(r.containerId)) ?? null : null,
      name: str(r.name) || 'Request',
      method: normalizeMethod(r.method),
      url: base.replace(/\{([A-Za-z_][\w-]*)\}/g, (_m, n: string) => (pathVars.some((p) => p.key === n) ? `{{${n}}}` : `{${n}}`)),
      params: query.length ? query : urlParams,
      headers: nameValues(r.headers, 'headers', w, loc),
      body: convertBody(r.body, w, loc),
      auth: convertAuth(r.auth, w, loc) ?? { type: 'inherit' },
      tests: tests.group,
      extractions: tests.extractions,
      variables: pathVars,
      scripts: { pre: typeof r.preReq === 'string' ? pre : '', post: typeof r.postReq === 'string' ? post : '' },
      docs: str(r.docs),
      settings: {
        ...(reqSettings.followRedirects !== undefined ? { followRedirects: reqSettings.followRedirects !== false } : {}),
        ...(typeof reqSettings.timeout === 'number' && reqSettings.timeout > 0 ? { timeoutMs: reqSettings.timeout } : {}),
      },
    });
    w.unknownKeys(
      r,
      ['_id', 'colId', 'containerId', 'name', 'url', 'method', 'sortNum', 'created', 'modified', 'headers', 'params', 'body', 'auth', 'tests', 'docs', 'preReq', 'postReq', 'reqSettings', 'reqType'],
      loc,
    );
  }
  return { collections: [b.build()], environments: [], warnings: w.list };
}

export function importThunderEnvironment(doc: unknown): ImportResult {
  if (!isThunderEnvironment(doc) || !isObject(doc)) throw importError('Not a Thunder Client environment export.');
  const w = new Warnings('thunder-environment');
  const name = str(doc.environmentName) || str(doc.name) || 'Thunder Client Environment';
  const variables = asArray(doc.variables)
    .filter(isObject)
    .map((v: JsonObject) => kv(str(v.name), str(v.value), { enabled: v.isDisabled !== true, ...(v.isSecret ? { secret: true } : {}) }));
  return { collections: [], environments: [parseEnvironment(createEnvironment({ name, variables }))], warnings: w.list };
}
