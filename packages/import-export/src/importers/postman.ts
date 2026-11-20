import { createEnvironment, kv, parseEnvironment, type Auth, type Folder, type HttpRequest, type KeyValue, type RequestBody, type RequestSettings, type Scripts } from '@reqvyn/core';
import { newId } from '@reqvyn/shared';
import type { ImportResult } from '../types.js';
import {
  CollectionBuilder,
  Warnings,
  asArray,
  bodyFromRaw,
  convertColonPathParams,
  importError,
  isObject,
  normalizeMethod,
  nowIso,
  splitUrl,
  str,
  type JsonObject,
} from '../util.js';

/** Postman Collection v2.0/v2.1 and Postman environment/globals importer. */

export function isPostmanCollection(doc: unknown): boolean {
  if (!isObject(doc) || !isObject(doc.info)) return false;
  const schema = str(doc.info.schema);
  return schema.includes('getpostman.com') || schema.includes('postman') || (Array.isArray(doc.item) && 'name' in doc.info);
}

export function isPostmanEnvironment(doc: unknown): boolean {
  return (
    isObject(doc) &&
    Array.isArray(doc.values) &&
    typeof doc.name === 'string' &&
    ('_postman_variable_scope' in doc || doc.values.every((v) => isObject(v) && 'key' in v))
  );
}

/** Postman auth params are arrays of {key,value} in v2.1 and plain objects in v2.0. */
function authParams(auth: JsonObject, type: string): Record<string, string> {
  const raw = auth[type];
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const p of raw) if (isObject(p) && typeof p.key === 'string') out[p.key] = str(p.value);
  } else if (isObject(raw)) {
    for (const [k, v] of Object.entries(raw)) out[k] = str(v);
  }
  return out;
}

export function convertPostmanAuth(auth: unknown, w: Warnings, location: string): Auth | undefined {
  if (!isObject(auth)) return undefined;
  const type = str(auth.type);
  const p = authParams(auth, type);
  switch (type) {
    case 'noauth':
      return { type: 'none' };
    case 'inherit':
      return { type: 'inherit' };
    case 'basic':
      return { type: 'basic', username: p.username ?? '', password: p.password ?? '' };
    case 'digest':
      if (p.realm || p.nonce || p.algorithm)
        w.add('converted', 'Digest auth realm/nonce/algorithm are negotiated at runtime and were not imported.', location, 'auth.digest');
      return { type: 'digest', username: p.username ?? '', password: p.password ?? '' };
    case 'bearer':
      return { type: 'bearer', token: p.token ?? '', prefix: 'Bearer' };
    case 'apikey':
      return { type: 'apikey', key: p.key ?? '', value: p.value ?? '', in: p.in === 'query' ? 'query' : 'header' };
    case 'awsv4':
      return {
        type: 'awsv4',
        accessKeyId: p.accessKey ?? '',
        secretAccessKey: p.secretKey ?? '',
        sessionToken: p.sessionToken ?? '',
        region: p.region || 'us-east-1',
        service: p.service || 'execute-api',
      };
    case 'jwt': {
      const alg = (p.algorithm || 'HS256') as Extract<Auth, { type: 'jwt' }>['algorithm'];
      const allowed = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384'];
      if (!allowed.includes(alg)) w.add('converted', `JWT algorithm ${alg} is not supported; HS256 used.`, location, 'auth.jwt.algorithm');
      return {
        type: 'jwt',
        algorithm: allowed.includes(alg) ? alg : 'HS256',
        secret: p.secret || p.privateKey || '',
        secretBase64: p.isSecretBase64Encoded === 'true',
        payload: p.payload || '{}',
        header: p.header || '{}',
        addTo: p.addTokenTo === 'queryParam' ? 'query' : 'header',
        headerPrefix: p.headerPrefix || 'Bearer',
        queryParam: p.queryParamKey || 'token',
      };
    }
    case 'oauth2': {
      const grant = p.grant_type || 'authorization_code';
      const map: Record<string, Extract<Auth, { type: 'oauth2' }>['grantType']> = {
        authorization_code: 'authorization_code',
        authorization_code_with_pkce: 'authorization_code',
        client_credentials: 'client_credentials',
        password_credentials: 'password',
        password: 'password',
      };
      const grantType = map[grant];
      if (!grantType) w.add('converted', `OAuth 2.0 grant type "${grant}" is not supported; authorization_code used.`, location, 'auth.oauth2.grant_type');
      if (p.accessToken) w.add('secret', 'A stored OAuth 2.0 access token was not imported; request a new token in REQVYN.', location, 'auth.oauth2.accessToken');
      return {
        type: 'oauth2',
        grantType: grantType ?? 'authorization_code',
        authUrl: p.authUrl ?? '',
        tokenUrl: p.accessTokenUrl ?? '',
        deviceAuthUrl: '',
        clientId: p.clientId ?? '',
        clientSecret: p.clientSecret ?? '',
        username: p.username ?? '',
        password: p.password ?? '',
        scope: p.scope ?? '',
        audience: p.audience ?? '',
        redirectUri: p.redirect_uri || 'http://127.0.0.1:0/callback',
        usePkce: grant === 'authorization_code_with_pkce' || p.challengeAlgorithm !== undefined,
        clientAuthentication: p.client_authentication === 'header' ? 'basic' : 'body',
        tokenPrefix: p.headerPrefix || 'Bearer',
        autoRefresh: true,
        extraParams: [],
      };
    }
    default:
      w.add('unsupported-feature', `Postman auth type "${type}" is not supported; auth set to none.`, location, `auth.${type}`);
      return { type: 'none' };
  }
}

function convertEvents(events: unknown, w: Warnings, location: string): Scripts {
  const scripts: Scripts = { pre: '', post: '' };
  for (const ev of asArray(events)) {
    if (!isObject(ev) || !isObject(ev.script)) continue;
    if (ev.disabled === true) {
      w.add('converted', `Disabled ${str(ev.listen)} script was not imported.`, location, 'event');
      continue;
    }
    const exec = ev.script.exec;
    const code = Array.isArray(exec) ? exec.map((l) => str(l)).join('\n') : str(exec);
    if (!code.trim()) continue;
    if (ev.listen === 'prerequest') scripts.pre = scripts.pre ? `${scripts.pre}\n${code}` : code;
    else if (ev.listen === 'test') scripts.post = scripts.post ? `${scripts.post}\n${code}` : code;
    else {
      w.add('unsupported-field', `Unknown script event "${str(ev.listen)}" was not imported.`, location, 'event');
      continue;
    }
    if (/\b(pm|postman)\./.test(code))
      w.add('script-needs-adaptation', `${ev.listen === 'test' ? 'Test' : 'Pre-request'} script uses the Postman "pm.*" API and was imported as-is; it may need adaptation.`, location, 'event');
  }
  return scripts;
}

function convertKeyValues(list: unknown, w: Warnings, location: string, field: string): KeyValue[] {
  const out: KeyValue[] = [];
  for (const item of asArray(list)) {
    if (!isObject(item)) continue;
    const key = str(item.key);
    if (!key && !str(item.value)) continue;
    const extra: Partial<KeyValue> = { enabled: item.disabled !== true };
    const desc = isObject(item.description) ? str(item.description.content) : str(item.description);
    if (desc) extra.description = desc;
    if (item.type === 'secret') extra.secret = true;
    if (item.type === 'file') w.add('unsupported-field', `File value for "${key}" is not supported here.`, location, field);
    out.push(kv(key, str(item.value), extra));
  }
  return out;
}

function description(d: unknown): string {
  if (isObject(d)) return str(d.content);
  return str(d);
}

function convertUrl(url: unknown, w: Warnings, location: string): { url: string; params: KeyValue[]; pathVars: KeyValue[] } {
  if (typeof url === 'string') {
    const { base, params } = splitUrl(url);
    const conv = convertColonPathParams(base);
    return { url: conv.url, params, pathVars: conv.names.map((n) => kv(n, '')) };
  }
  if (!isObject(url)) return { url: '', params: [], pathVars: [] };
  let raw = str(url.raw);
  if (!raw) {
    const protocol = str(url.protocol);
    const host = Array.isArray(url.host) ? url.host.map((h) => str(h)).join('.') : str(url.host);
    const path = Array.isArray(url.path) ? url.path.map((p) => (isObject(p) ? str(p.value) : str(p))).join('/') : str(url.path);
    const port = url.port ? `:${str(url.port)}` : '';
    raw = `${protocol ? `${protocol}://` : ''}${host}${port}${path ? `/${path.replace(/^\//, '')}` : ''}`;
  }
  const { base } = splitUrl(raw);
  const params = Array.isArray(url.query) ? convertKeyValues(url.query, w, location, 'url.query') : splitUrl(raw).params;
  const conv = convertColonPathParams(base);
  const pathVars: KeyValue[] = [];
  const declared = new Map<string, string>();
  for (const v of asArray(url.variable)) if (isObject(v)) declared.set(str(v.key), str(v.value));
  for (const n of conv.names) pathVars.push(kv(n, declared.get(n) ?? ''));
  return { url: conv.url, params, pathVars };
}

function convertBody(body: unknown, headers: KeyValue[], w: Warnings, location: string): RequestBody {
  if (!isObject(body) || !body.mode) return { mode: 'none' };
  if (body.disabled === true) {
    w.add('converted', 'Body was disabled in Postman and was not imported.', location, 'body.disabled');
    return { mode: 'none' };
  }
  switch (body.mode) {
    case 'raw': {
      const text = str(body.raw);
      const lang = isObject(body.options) && isObject(body.options.raw) ? str(body.options.raw.language) : '';
      const ct = headers.find((h) => h.enabled && h.key.toLowerCase() === 'content-type')?.value;
      if (lang === 'json') return { mode: 'json', text };
      if (lang === 'xml' || lang === 'html') return lang === 'xml' ? { mode: 'xml', text } : { mode: 'text', text, contentType: 'text/html' };
      return bodyFromRaw(text, ct);
    }
    case 'urlencoded':
      return { mode: 'urlencoded', fields: convertKeyValues(body.urlencoded, w, location, 'body.urlencoded') };
    case 'formdata':
      return {
        mode: 'multipart',
        parts: asArray(body.formdata)
          .filter(isObject)
          .map((p) => {
            const isFile = p.type === 'file';
            const src = Array.isArray(p.src) ? str(p.src[0]) : str(p.src);
            if (isFile && Array.isArray(p.src) && p.src.length > 1)
              w.add('converted', `Only the first file of multi-file field "${str(p.key)}" was imported.`, location, 'body.formdata.src');
            return {
              id: newId(),
              key: str(p.key),
              enabled: p.disabled !== true,
              type: isFile ? ('file' as const) : ('text' as const),
              value: isFile ? '' : str(p.value),
              ...(isFile && src ? { filePath: src } : {}),
              ...(p.contentType ? { contentType: str(p.contentType) } : {}),
            };
          }),
      };
    case 'file': {
      const src = isObject(body.file) ? str(body.file.src) : '';
      return { mode: 'binary', filePath: src };
    }
    case 'graphql': {
      const g = isObject(body.graphql) ? body.graphql : {};
      return { mode: 'graphql', query: str(g.query), variables: str(g.variables) };
    }
    default:
      w.add('unsupported-feature', `Body mode "${str(body.mode)}" is not supported.`, location, 'body.mode');
      return { mode: 'none' };
  }
}

function convertSettings(item: JsonObject, w: Warnings, location: string): RequestSettings {
  const settings: RequestSettings = {};
  const ppb = item.protocolProfileBehavior;
  if (!isObject(ppb)) return settings;
  for (const [k, v] of Object.entries(ppb)) {
    if (k === 'followRedirects' && typeof v === 'boolean') settings.followRedirects = v;
    else if (k === 'maxRedirects' && typeof v === 'number') settings.maxRedirects = v;
    else if (k === 'strictSSL' && v === false) {
      settings.verifyTls = false;
      w.add('insecure', 'TLS certificate verification is disabled for this request (strictSSL: false).', location, 'protocolProfileBehavior.strictSSL');
    } else if (k === 'disableUrlEncoding' && typeof v === 'boolean') settings.encodeUrl = !v;
    else if (k === 'disableCookies' && typeof v === 'boolean') settings.useCookieJar = !v;
    else if (k === 'disableBodyPruning') continue;
    else w.add('unsupported-field', `Protocol setting "${k}" is not supported.`, location, `protocolProfileBehavior.${k}`);
  }
  return settings;
}

export function importPostmanCollection(doc: unknown, fileName?: string): ImportResult {
  if (!isPostmanCollection(doc) || !isObject(doc)) throw importError('Not a Postman collection.');
  const info = doc.info as JsonObject;
  const w = new Warnings('postman');
  const name = str(info.name) || 'Postman Collection';
  const schema = str(info.schema);
  if (schema && !schema.includes('v2.1') && !schema.includes('v2.0'))
    w.add('converted', `Postman schema "${schema}" is not v2.x; import attempted as v2.1.`, name, 'info.schema');

  const b = new CollectionBuilder({
    name,
    description: description(info.description),
    variables: convertKeyValues(doc.variable, w, name, 'variable'),
    auth: convertPostmanAuth(doc.auth, w, name) ?? { type: 'none' },
    scripts: convertEvents(doc.event, w, name),
    meta: { source: { type: 'postman', ...(fileName ? { location: fileName } : {}), importedAt: nowIso() } },
  });
  if (b.collection.auth.type === 'inherit') b.collection.auth = { type: 'none' };

  let exampleCount = 0;
  const walk = (items: unknown, parentId: string | null, path: string) => {
    for (const it of asArray(items)) {
      if (!isObject(it)) continue;
      const itemName = str(it.name) || 'Untitled';
      const loc = `${path} / ${itemName}`;
      if (Array.isArray(it.item) || !it.request) {
        const folder: Folder = b.addFolder({
          parentId,
          name: itemName,
          description: description(it.description),
          auth: convertPostmanAuth(it.auth, w, loc) ?? { type: 'inherit' },
          scripts: convertEvents(it.event, w, loc),
          variables: convertKeyValues(it.variable, w, loc, 'variable'),
        });
        w.unknownKeys(it, ['name', 'item', 'description', 'auth', 'event', 'variable', 'id', '_postman_id', '_postman_isSubFolder', 'protocolProfileBehavior'], loc);
        walk(it.item, folder.id, loc);
        continue;
      }
      const req: JsonObject = typeof it.request === 'string' ? { url: it.request, method: 'GET' } : isObject(it.request) ? it.request : {};
      const headers = convertKeyValues(req.header, w, loc, 'request.header');
      const url = convertUrl(req.url, w, loc);
      const request: Partial<HttpRequest> & { parentId: string | null } = {
        parentId,
        name: itemName,
        method: normalizeMethod(req.method),
        url: url.url,
        params: url.params,
        headers,
        body: convertBody(req.body, headers, w, loc),
        auth: convertPostmanAuth(req.auth, w, loc) ?? { type: 'inherit' },
        scripts: convertEvents(it.event, w, loc),
        variables: url.pathVars,
        settings: convertSettings(it, w, loc),
        docs: description(req.description) || description(it.description),
      };
      if (Array.isArray(it.response) && it.response.length > 0) exampleCount += it.response.length;
      if (req.certificate) w.add('unsupported-field', 'Request certificate settings are not supported.', loc, 'request.certificate');
      if (req.proxy) w.add('unsupported-field', 'Per-request proxy settings are not supported.', loc, 'request.proxy');
      w.unknownKeys(req, ['method', 'header', 'url', 'body', 'auth', 'description', 'certificate', 'proxy'], loc, 'request.');
      b.addRequest(request);
    }
  };
  walk(doc.item, null, name);
  if (exampleCount > 0)
    w.add('unsupported-field', `${exampleCount} saved response example(s) were not imported (REQVYN keeps response history separately).`, name, 'response');
  w.unknownKeys(doc, ['info', 'item', 'variable', 'auth', 'event', 'protocolProfileBehavior'], name);
  return { collections: [b.build()], environments: [], warnings: w.list };
}

export function importPostmanEnvironment(doc: unknown): ImportResult {
  if (!isPostmanEnvironment(doc) || !isObject(doc)) throw importError('Not a Postman environment.');
  const w = new Warnings('postman-environment');
  const name = str(doc.name) || 'Postman Environment';
  const scope = str(doc._postman_variable_scope);
  if (scope === 'globals') w.add('converted', 'Postman globals were imported as an environment.', name);
  const variables = asArray(doc.values)
    .filter(isObject)
    .map((v) => kv(str(v.key), str(v.value), { enabled: v.enabled !== false, ...(v.type === 'secret' ? { secret: true } : {}) }));
  const env = parseEnvironment(createEnvironment({ name: scope === 'globals' ? `${name} (globals)` : name, variables }));
  return { collections: [], environments: [env], warnings: w.list };
}
