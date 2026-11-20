import { type Assertion, type AssertionGroup, type Auth, type Collection, type Environment, type Extraction, type HttpRequest, type KeyValue, type RequestBody, type RequestSettings, type Scripts } from '@reqvyn/core';
import { environmentTemplate, sanitizeCollection, type SensitiveFinding } from '../secrets.js';
import type { ExportResult, ExportWarning } from '../types.js';
import { splitUrl } from '../util.js';

/** Export to Postman Collection Format v2.1.0. Secrets are blanked unless `includeSecrets` is set. */

export const POSTMAN_SCHEMA_V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

export interface PostmanExportOptions {
  includeSecrets?: boolean;
  redactSensitiveHeaders?: boolean;
  /** Convert scriptless assertions/extractions into `pm.*` test script code (default true). */
  convertTests?: boolean;
}

type PmKv = { key: string; value: string; disabled?: boolean; description?: string; type?: string };
type PmAuthParam = { key: string; value: unknown; type: string };
type PmAuth = { type: string } & Record<string, unknown>;
type PmEvent = { listen: 'prerequest' | 'test'; script: { type: 'text/javascript'; exec: string[] } };
type PmItem = Record<string, unknown>;

export interface PostmanCollectionDoc {
  info: { _postman_id: string; name: string; description?: string; schema: string };
  item: PmItem[];
  variable?: PmKv[];
  auth?: PmAuth;
  event?: PmEvent[];
}

function kvs(list: KeyValue[]): PmKv[] {
  return list
    .filter((x) => x.key || x.value)
    .map((x) => ({
      key: x.key,
      value: x.value,
      ...(x.enabled ? {} : { disabled: true }),
      ...(x.description ? { description: x.description } : {}),
      ...(x.secret ? { type: 'secret' } : {}),
    }));
}

function params(entries: Record<string, unknown>): PmAuthParam[] {
  return Object.entries(entries).map(([key, value]) => ({ key, value, type: typeof value === 'boolean' ? 'boolean' : 'string' }));
}

export function toPostmanAuth(auth: Auth, w: ExportWarning[], location: string): PmAuth | undefined {
  switch (auth.type) {
    case 'inherit':
      return undefined;
    case 'none':
      return { type: 'noauth' };
    case 'basic':
      return { type: 'basic', basic: params({ username: auth.username, password: auth.password }) };
    case 'digest':
      return { type: 'digest', digest: params({ username: auth.username, password: auth.password }) };
    case 'bearer':
      if (auth.prefix && auth.prefix !== 'Bearer') w.push({ code: 'converted', message: `Bearer prefix "${auth.prefix}" is not supported by Postman; "Bearer" will be used.`, location, field: 'auth.prefix' });
      return { type: 'bearer', bearer: params({ token: auth.token }) };
    case 'apikey':
      return { type: 'apikey', apikey: params({ key: auth.key, value: auth.value, in: auth.in }) };
    case 'awsv4':
      return { type: 'awsv4', awsv4: params({ accessKey: auth.accessKeyId, secretKey: auth.secretAccessKey, sessionToken: auth.sessionToken, region: auth.region, service: auth.service }) };
    case 'jwt':
      return {
        type: 'jwt',
        jwt: params({
          algorithm: auth.algorithm,
          secret: auth.secret,
          isSecretBase64Encoded: auth.secretBase64,
          payload: auth.payload,
          header: auth.header,
          addTokenTo: auth.addTo === 'query' ? 'queryParam' : 'header',
          headerPrefix: auth.headerPrefix,
          queryParamKey: auth.queryParam,
        }),
      };
    case 'oauth2': {
      const grant = auth.grantType === 'password' ? 'password_credentials' : auth.grantType === 'authorization_code' && auth.usePkce ? 'authorization_code_with_pkce' : auth.grantType;
      if (auth.grantType === 'device_code') w.push({ code: 'unsupported-feature', message: 'OAuth 2.0 device code grant is not supported by Postman.', location, field: 'auth.grantType' });
      return {
        type: 'oauth2',
        oauth2: params({
          grant_type: grant,
          authUrl: auth.authUrl,
          accessTokenUrl: auth.tokenUrl,
          clientId: auth.clientId,
          clientSecret: auth.clientSecret,
          username: auth.username,
          password: auth.password,
          scope: auth.scope,
          redirect_uri: auth.redirectUri,
          client_authentication: auth.clientAuthentication === 'basic' ? 'header' : 'body',
          headerPrefix: auth.tokenPrefix,
          addTokenTo: 'header',
          ...(auth.audience ? { audience: auth.audience } : {}),
        }),
      };
    }
    case 'clientcert':
      w.push({ code: 'unsupported-feature', message: 'Client certificates are configured per host in Postman settings and were not exported.', location, field: 'auth.clientcert' });
      return { type: 'noauth' };
  }
}

const js = (s: string) => JSON.stringify(s);

function jsonPathToJs(path: string): string | undefined {
  // Simple JSONPath ($.a.b[0].c / $['a']) -> JS accessor on `json`.
  const p = path.trim();
  if (p === '$' || p === '') return 'json';
  if (!p.startsWith('$')) return undefined;
  let out = 'json';
  const re = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]/gy;
  re.lastIndex = 1;
  let consumed = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p))) {
    consumed = re.lastIndex;
    if (m[1] !== undefined) out += `.${m[1]}`;
    else if (m[2] !== undefined) out += `[${m[2]}]`;
    else out += `[${js(m[3] ?? m[4] ?? '')}]`;
  }
  return consumed === p.length ? out : undefined;
}

function valueExpr(a: Assertion): string | undefined {
  switch (a.source) {
    case 'status':
      return 'pm.response.code';
    case 'responseTime':
      return 'pm.response.responseTime';
    case 'body':
      return 'pm.response.text()';
    case 'header':
      return `pm.response.headers.get(${js(a.path)})`;
    case 'contentType':
      return `pm.response.headers.get("Content-Type")`;
    case 'size':
      return 'pm.response.responseSize';
    case 'cookie':
      return `pm.cookies.get(${js(a.path)})`;
    case 'json': {
      const acc = jsonPathToJs(a.path);
      return acc ? `(() => { const json = pm.response.json(); return ${acc}; })()` : undefined;
    }
  }
}

function expectedLiteral(a: Assertion): string {
  const e = a.expected.trim();
  if (/^-?\d+(\.\d+)?$/.test(e) || e === 'true' || e === 'false' || e === 'null') return e;
  return js(a.expected);
}

function assertionToPm(a: Assertion): string | undefined {
  const v = valueExpr(a);
  if (!v) return undefined;
  const ex = expectedLiteral(a);
  const name = a.description || `${a.source}${a.path ? ` ${a.path}` : ''} ${a.operator} ${a.expected}`.trim();
  const body = (() => {
    switch (a.operator) {
      case 'eq':
        return `pm.expect(${v}).to.eql(${ex});`;
      case 'neq':
        return `pm.expect(${v}).to.not.eql(${ex});`;
      case 'lt':
        return `pm.expect(${v}).to.be.below(${Number(a.expected)});`;
      case 'lte':
        return `pm.expect(${v}).to.be.at.most(${Number(a.expected)});`;
      case 'gt':
        return `pm.expect(${v}).to.be.above(${Number(a.expected)});`;
      case 'gte':
        return `pm.expect(${v}).to.be.at.least(${Number(a.expected)});`;
      case 'contains':
        return `pm.expect(String(${v})).to.include(${js(a.expected)});`;
      case 'notContains':
        return `pm.expect(String(${v})).to.not.include(${js(a.expected)});`;
      case 'startsWith':
        return `pm.expect(String(${v}).startsWith(${js(a.expected)})).to.be.true;`;
      case 'endsWith':
        return `pm.expect(String(${v}).endsWith(${js(a.expected)})).to.be.true;`;
      case 'exists':
        return `pm.expect(${v}).to.exist;`;
      case 'notExists':
        return `pm.expect(${v}).to.not.exist;`;
      case 'matches':
        return `pm.expect(String(${v})).to.match(new RegExp(${js(a.expected)}));`;
      case 'isType':
        return `pm.expect(${v}).to.be.a(${js(a.expected)});`;
      case 'lengthEq':
        return `pm.expect(${v}).to.have.lengthOf(${Number(a.expected)});`;
      case 'arrayContains':
        return `pm.expect(${v}).to.deep.include(${ex});`;
      case 'isJson':
        return `pm.response.json();`;
      default:
        return undefined;
    }
  })();
  return body ? `pm.test(${js(name)}, function () {\n    ${body}\n});` : undefined;
}

function groupToPm(g: AssertionGroup, w: ExportWarning[], location: string): string[] {
  const out: string[] = [];
  if (!g.enabled) return out;
  if (g.logic === 'or' && g.items.length > 1) {
    w.push({ code: 'unsupported-feature', message: 'An "any of" (OR) assertion group cannot be expressed as Postman tests and was not exported.', location, field: 'tests' });
    return out;
  }
  for (const item of g.items) {
    if (item.kind === 'group') out.push(...groupToPm(item, w, location));
    else if (item.enabled) {
      const code = assertionToPm(item);
      if (code) out.push(code);
      else w.push({ code: 'unsupported-feature', message: `Assertion "${item.source} ${item.path} ${item.operator}" has no Postman equivalent and was not exported.`, location, field: 'tests' });
    }
  }
  return out;
}

function extractionToPm(e: Extraction): string | undefined {
  if (!e.enabled) return undefined;
  const target = e.scope === 'environment' ? 'pm.environment' : e.scope === 'global' ? 'pm.globals' : e.scope === 'collection' ? 'pm.collectionVariables' : 'pm.variables';
  let expr: string | undefined;
  if (e.source === 'json') {
    const acc = jsonPathToJs(e.path);
    expr = acc ? `(() => { const json = pm.response.json(); return ${acc}; })()` : undefined;
  } else if (e.source === 'header') expr = `pm.response.headers.get(${js(e.path)})`;
  else if (e.source === 'status') expr = 'pm.response.code';
  else if (e.source === 'cookie') expr = `pm.cookies.get(${js(e.path)})`;
  else if (e.source === 'body') expr = 'pm.response.text()';
  else if (e.source === 'regex') expr = `((pm.response.text().match(new RegExp(${js(e.path)})) || [])[1])`;
  return expr ? `${target}.set(${js(e.variable)}, ${expr});` : undefined;
}

function events(scripts: Scripts, generated: string[], w: ExportWarning[], location: string): PmEvent[] | undefined {
  const out: PmEvent[] = [];
  if (scripts.pre.trim()) out.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: scripts.pre.split('\n') } });
  const test = [scripts.post.trim() ? scripts.post : '', ...generated].filter(Boolean).join('\n\n');
  if (test) out.push({ listen: 'test', script: { type: 'text/javascript', exec: test.split('\n') } });
  if ((scripts.pre + scripts.post).includes('rq.'))
    w.push({ code: 'script-needs-adaptation', message: 'Scripts use the REQVYN "rq.*" API and were exported as-is; they need adaptation for Postman.', location, field: 'scripts' });
  return out.length ? out : undefined;
}

function urlObject(r: HttpRequest): Record<string, unknown> {
  const { base, params: inline } = splitUrl(r.url);
  const varNames = new Set(r.variables.map((v) => v.key));
  // REQVYN path variables are `{{name}}` segments backed by request variables -> Postman `:name`.
  const pathVars: PmKv[] = [];
  const converted = base.replace(/(^|\/)\{\{\s*([A-Za-z_][\w-]*)\s*\}\}(?=\/|$)/g, (m, pre: string, name: string) => {
    if (!varNames.has(name)) return m;
    const v = r.variables.find((x) => x.key === name);
    pathVars.push({ key: name, value: v?.value ?? '', ...(v?.description ? { description: v.description } : {}) });
    return `${pre}:${name}`;
  });
  const query = [...kvs(inline), ...kvs(r.params)];
  const qs = query.filter((q) => !q.disabled).map((q) => (q.value === '' ? q.key : `${q.key}=${q.value}`)).join('&');
  const raw = qs ? `${converted}?${qs}` : converted;
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(.*)$/i.exec(converted);
  const out: Record<string, unknown> = { raw };
  if (m) {
    out.protocol = m[1];
    const hostPort = m[2] ?? '';
    const portMatch = /^(.*):(\d+)$/.exec(hostPort);
    out.host = (portMatch ? portMatch[1] ?? '' : hostPort).split('.');
    if (portMatch) out.port = portMatch[2];
    out.path = (m[3] ?? '').split('/').filter(Boolean);
  } else {
    const [host, ...path] = converted.split('/');
    out.host = [host ?? ''];
    out.path = path.filter(Boolean);
  }
  if (query.length) out.query = query;
  if (pathVars.length) out.variable = pathVars;
  return out;
}

function bodyObject(b: RequestBody, headers: PmKv[], w: ExportWarning[], location: string): Record<string, unknown> | undefined {
  const ensureCt = (ct: string) => {
    if (!headers.some((h) => h.key.toLowerCase() === 'content-type')) headers.push({ key: 'Content-Type', value: ct });
  };
  switch (b.mode) {
    case 'none':
      return undefined;
    case 'json':
      return { mode: 'raw', raw: b.text, options: { raw: { language: 'json' } } };
    case 'xml':
      return { mode: 'raw', raw: b.text, options: { raw: { language: 'xml' } } };
    case 'text':
      if (b.contentType) ensureCt(b.contentType);
      return { mode: 'raw', raw: b.text, options: { raw: { language: 'text' } } };
    case 'urlencoded':
      return { mode: 'urlencoded', urlencoded: kvs(b.fields) };
    case 'multipart':
      return {
        mode: 'formdata',
        formdata: b.parts.map((p) => ({
          key: p.key,
          ...(p.type === 'file' ? { type: 'file', src: p.filePath ?? '' } : { type: 'text', value: p.value }),
          ...(p.enabled ? {} : { disabled: true }),
          ...(p.contentType ? { contentType: p.contentType } : {}),
        })),
      };
    case 'binary':
      if (b.contentType) ensureCt(b.contentType);
      w.push({ code: 'info', message: 'Binary body file paths are machine specific; re-select the file in Postman.', location, field: 'body' });
      return { mode: 'file', file: { src: b.filePath } };
    case 'graphql':
      return { mode: 'graphql', graphql: { query: b.query, variables: b.variables } };
  }
}

function settingsBehavior(s: RequestSettings, w: ExportWarning[], location: string): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (s.followRedirects !== undefined) out.followRedirects = s.followRedirects;
  if (s.maxRedirects !== undefined) out.maxRedirects = s.maxRedirects;
  if (s.verifyTls === false) out.strictSSL = false;
  if (s.encodeUrl !== undefined) out.disableUrlEncoding = !s.encodeUrl;
  if (s.useCookieJar !== undefined) out.disableCookies = !s.useCookieJar;
  const dropped = (['timeoutMs', 'decompress', 'maxResponseBytes'] as const).filter((k) => s[k] !== undefined);
  if (dropped.length) w.push({ code: 'unsupported-field', message: `Request settings ${dropped.join(', ')} have no per-request Postman equivalent.`, location, field: 'settings' });
  return Object.keys(out).length ? out : undefined;
}

function requestItem(r: HttpRequest, w: ExportWarning[], location: string, convertTests: boolean): PmItem {
  const header = kvs(r.headers);
  if (r.cookies.some((c) => c.enabled && c.key)) {
    const cookie = r.cookies.filter((c) => c.enabled && c.key).map((c) => `${c.key}=${c.value}`).join('; ');
    header.push({ key: 'Cookie', value: cookie });
    w.push({ code: 'converted', message: 'Request cookies were exported as a "Cookie" header.', location, field: 'cookies' });
  }
  const body = bodyObject(r.body, header, w, location);
  const auth = toPostmanAuth(r.auth, w, location);
  const generated: string[] = [];
  if (convertTests) {
    generated.push(...groupToPm(r.tests, w, location));
    for (const e of r.extractions) {
      const code = extractionToPm(e);
      if (code) generated.push(code);
      else if (e.enabled) w.push({ code: 'unsupported-feature', message: `Extraction of "${e.variable}" could not be converted.`, location, field: 'extractions' });
    }
    if (generated.length) w.push({ code: 'converted', message: `${generated.length} assertion(s)/extraction(s) were converted into Postman test script code.`, location, field: 'tests' });
  } else if (r.tests.items.length || r.extractions.length) {
    w.push({ code: 'unsupported-feature', message: 'Scriptless assertions and extractions were not exported.', location, field: 'tests' });
  }
  const varNames = new Set(r.variables.map((v) => v.key));
  const pathVarNames = new Set([...r.url.matchAll(/\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g)].map((m) => m[1]));
  const nonPath = [...varNames].filter((n) => !pathVarNames.has(n));
  if (nonPath.length) w.push({ code: 'unsupported-field', message: `Request variables (${nonPath.join(', ')}) are not supported by Postman and were not exported.`, location, field: 'variables' });
  const event = events(r.scripts, generated, w, location);
  const ppb = settingsBehavior(r.settings, w, location);
  return {
    name: r.name,
    ...(event ? { event } : {}),
    ...(ppb ? { protocolProfileBehavior: ppb } : {}),
    request: {
      method: r.method,
      header,
      ...(body ? { body } : {}),
      url: urlObject(r),
      ...(auth ? { auth } : {}),
      ...(r.docs ? { description: r.docs } : {}),
    },
    response: [],
  };
}

export function exportPostman(collectionIn: Collection, opts: PostmanExportOptions = {}): ExportResult<PostmanCollectionDoc> & { removed: SensitiveFinding[] } {
  const { collection: c, removed } = sanitizeCollection(collectionIn, { includeSecrets: opts.includeSecrets === true, redactSensitiveHeaders: opts.redactSensitiveHeaders });
  const w: ExportWarning[] = [];
  const convertTests = opts.convertTests !== false;
  if (removed.length)
    w.push({ code: 'secret', message: `${removed.length} secret value(s) were blanked. Re-enter them in Postman or export with secrets explicitly enabled.` });

  const folderItems = (parentId: string | null, path: string): PmItem[] => {
    const folders = c.folders.filter((f) => f.parentId === parentId);
    const requests = c.requests.filter((r) => r.parentId === parentId);
    const entries: Array<{ sortKey: number; item: PmItem }> = [];
    for (const f of folders) {
      const loc = `${path} / ${f.name}`;
      const auth = toPostmanAuth(f.auth, w, loc);
      const generated = convertTests ? groupToPm(f.tests, w, loc) : [];
      const event = events(f.scripts, generated, w, loc);
      if (f.headers.some((h) => h.enabled && h.key))
        w.push({ code: 'unsupported-field', message: 'Folder headers are not supported by Postman and were not exported.', location: loc, field: 'headers' });
      if (Object.values(f.settings).some((v) => v !== undefined)) w.push({ code: 'unsupported-field', message: 'Folder settings were not exported.', location: loc, field: 'settings' });
      entries.push({
        sortKey: f.sortKey,
        item: {
          name: f.name,
          ...(f.description ? { description: f.description } : {}),
          item: folderItems(f.id, loc),
          ...(auth ? { auth } : {}),
          ...(event ? { event } : {}),
          ...(f.variables.length ? { variable: kvs(f.variables) } : {}),
        },
      });
    }
    for (const r of requests) entries.push({ sortKey: r.sortKey, item: requestItem(r, w, `${path} / ${r.name}`, convertTests) });
    return entries.sort((a, b) => a.sortKey - b.sortKey).map((e) => e.item);
  };

  if (c.headers.some((h) => h.enabled && h.key))
    w.push({ code: 'unsupported-field', message: 'Collection-level headers are not supported by Postman and were not exported.', location: c.name, field: 'headers' });
  const auth = toPostmanAuth(c.auth, w, c.name);
  const generated = convertTests ? groupToPm(c.tests, w, c.name) : [];
  const event = events(c.scripts, generated, w, c.name);
  const doc: PostmanCollectionDoc = {
    info: { _postman_id: c.id, name: c.name, ...(c.description ? { description: c.description } : {}), schema: POSTMAN_SCHEMA_V21 },
    item: folderItems(null, c.name),
    ...(c.variables.length ? { variable: kvs(c.variables) } : {}),
    ...(auth ? { auth } : {}),
    ...(event ? { event } : {}),
  };
  return { text: JSON.stringify(doc, null, 2), data: doc, warnings: w, removed };
}

export interface PostmanEnvironmentDoc {
  id: string;
  name: string;
  values: Array<{ key: string; value: string; type: 'default' | 'secret'; enabled: boolean }>;
  _postman_variable_scope: 'environment';
}

/** Export an environment to the Postman environment format (as a template by default). */
export function exportPostmanEnvironment(env: Environment, opts: { includeSecrets?: boolean; includeEnvironmentValues?: boolean } = {}): ExportResult<PostmanEnvironmentDoc> & { removed: SensitiveFinding[] } {
  const { environment, removed } = environmentTemplate(env, opts);
  const doc: PostmanEnvironmentDoc = {
    id: environment.id,
    name: environment.name,
    values: environment.variables.map((v) => ({ key: v.key, value: v.value, type: v.secret ? 'secret' : 'default', enabled: v.enabled })),
    _postman_variable_scope: 'environment',
  };
  const warnings: ExportWarning[] = removed.length ? [{ code: 'secret', message: `${removed.length} value(s) were blanked in the environment template.`, location: env.name }] : [];
  return { text: JSON.stringify(doc, null, 2), data: doc, warnings, removed };
}
