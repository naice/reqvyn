import {
  createAssertion,
  createEnvironment,
  emptyGroup,
  kv,
  parseEnvironment,
  type Auth,
  type Environment,
  type Folder,
  type KeyValue,
  type MultipartPart,
  type RequestBody,
} from '@reqvyn/core';
import { newId } from '@reqvyn/shared';
import { contentHash } from '@reqvyn/shared/node';
import { parse as parseYaml } from 'yaml';
import type { ImportResult } from '../types.js';
import { CollectionBuilder, Warnings, asArray, importError, isObject, nowIso, str, type JsonObject } from '../util.js';

/** OpenAPI 3.x (JSON or YAML) importer. */

export const OPENAPI_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export interface OpenApiImportOptions {
  fileName?: string;
  /** Group operations into folders by their first tag (default true). */
  groupByTags?: boolean;
  /** Add a disabled "matches schema" assertion per operation with a JSON response schema (default true). */
  schemaAssertions?: boolean;
}

/** Parse an OpenAPI/Swagger document from JSON or YAML text. */
export function parseSpecText(text: string): unknown {
  const t = text.replace(/^\uFEFF/, '').trim();
  if (t.startsWith('{')) {
    try {
      return JSON.parse(t);
    } catch (e) {
      throw importError('The OpenAPI document is not valid JSON.', undefined, e);
    }
  }
  try {
    return parseYaml(t, { maxAliasCount: 1000 });
  } catch (e) {
    throw importError('The OpenAPI document is not valid YAML.', undefined, e);
  }
}

export function isOpenApi(doc: unknown): boolean {
  return isObject(doc) && typeof doc.openapi === 'string' && doc.openapi.startsWith('3.') && (isObject(doc.paths) || isObject(doc.webhooks) || isObject(doc.components));
}

export function isSwagger2(doc: unknown): boolean {
  return isObject(doc) && typeof doc.swagger === 'string' && doc.swagger.startsWith('2');
}

// ---------------------------------------------------------------------------------------------
// $ref resolution
// ---------------------------------------------------------------------------------------------

export class RefResolver {
  private readonly cache = new Map<string, unknown>();
  private externalWarned = false;
  constructor(
    private readonly root: unknown,
    private readonly w?: Warnings,
  ) {}

  pointer(ref: string): unknown {
    if (!ref.startsWith('#')) return undefined;
    const parts = ref
      .slice(1)
      .split('/')
      .filter((p, i) => i > 0 || p !== '')
      .map((p) => decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~')));
    let cur: unknown = this.root;
    for (const p of parts) {
      if (Array.isArray(cur)) cur = cur[Number(p)];
      else if (isObject(cur)) cur = cur[p];
      else return undefined;
    }
    return cur;
  }

  /** Deeply dereference local `$ref`s. Cycles are cut and replaced by `{ "x-circular": ref }`. */
  deref(node: unknown, stack: string[] = [], depth = 0): unknown {
    if (depth > 64) return {};
    if (Array.isArray(node)) return node.map((n) => this.deref(n, stack, depth + 1));
    if (!isObject(node)) return node;
    if (typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (!ref.startsWith('#')) {
        if (!this.externalWarned) this.w?.add('unsupported-feature', `External $ref "${ref}" (and possibly others) cannot be resolved; replaced with an empty schema.`, undefined, '$ref');
        this.externalWarned = true;
        return {};
      }
      if (stack.includes(ref)) return { 'x-circular': ref };
      const cached = stack.length === 0 ? this.cache.get(ref) : undefined;
      if (cached !== undefined) return cached;
      const target = this.pointer(ref);
      if (target === undefined) {
        this.w?.add('converted', `Unresolvable $ref "${ref}" replaced with an empty schema.`, undefined, '$ref');
        return {};
      }
      const { $ref: _r, ...siblings } = node;
      const resolved = this.deref(target, [...stack, ref], depth + 1);
      const out = Object.keys(siblings).length && isObject(resolved) ? { ...resolved, ...(this.deref(siblings, stack, depth + 1) as JsonObject) } : resolved;
      return out;
    }
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(node)) out[k] = this.deref(v, stack, depth + 1);
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Example generation
// ---------------------------------------------------------------------------------------------

const STRING_FORMATS: Record<string, string> = {
  'date-time': '2024-01-01T00:00:00Z',
  date: '2024-01-01',
  time: '12:00:00',
  email: 'user@example.com',
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
  byte: 'U3dhZ2dlcg==',
  binary: '',
  password: '',
};

export function exampleFromSchema(schema: unknown, depth = 0): unknown {
  if (!isObject(schema) || depth > 12) return null;
  if ('example' in schema) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if ('default' in schema) return schema.default;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((s) => exampleFromSchema(s, depth + 1));
    if (parts.every((p) => isObject(p) || p === null)) return Object.assign({}, ...parts.filter(isObject));
    return parts.find((p) => p !== null) ?? null;
  }
  for (const k of ['oneOf', 'anyOf'] as const) {
    const list = schema[k];
    if (Array.isArray(list) && list.length) return exampleFromSchema(list[0], depth + 1);
  }
  if (schema['x-circular']) return {};
  let type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (!type) type = isObject(schema.properties) ? 'object' : schema.items ? 'array' : undefined;
  switch (type) {
    case 'object': {
      const out: JsonObject = {};
      if (isObject(schema.properties)) {
        for (const [k, v] of Object.entries(schema.properties)) {
          if (isObject(v) && v.readOnly === true) continue;
          out[k] = exampleFromSchema(v, depth + 1);
        }
      } else if (isObject(schema.additionalProperties)) out.key = exampleFromSchema(schema.additionalProperties, depth + 1);
      return out;
    }
    case 'array':
      return schema.items ? [exampleFromSchema(schema.items, depth + 1)] : [];
    case 'integer':
      return typeof schema.minimum === 'number' ? Math.ceil(schema.minimum) : 0;
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'boolean':
      return true;
    case 'string': {
      const f = str(schema.format);
      if (f in STRING_FORMATS) return STRING_FORMATS[f];
      return 'string';
    }
    default:
      return null;
  }
}

function mediaExample(media: JsonObject): unknown {
  if ('example' in media) return media.example;
  if (isObject(media.examples)) {
    const first = Object.values(media.examples)[0];
    if (isObject(first) && 'value' in first) return first.value;
  }
  return exampleFromSchema(media.schema);
}

function paramExample(p: JsonObject): string {
  let v: unknown;
  if ('example' in p) v = p.example;
  else if (isObject(p.examples)) {
    const first = Object.values(p.examples)[0];
    v = isObject(first) ? first.value : undefined;
  } else v = exampleFromSchema(p.schema);
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => str(x)).join(',');
  return str(v);
}

// ---------------------------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------------------------

interface SecurityPlaceholder {
  auth: Auth;
  variables: KeyValue[];
}

function variableName(schemeName: string, suffix: string): string {
  const base = schemeName.replace(/[^A-Za-z0-9_]/g, '_');
  return `${base}${suffix}`;
}

export function securitySchemeToAuth(name: string, scheme: unknown, w: Warnings): SecurityPlaceholder | undefined {
  if (!isObject(scheme)) return undefined;
  const type = str(scheme.type);
  if (type === 'http') {
    const s = str(scheme.scheme).toLowerCase();
    if (s === 'basic')
      return {
        auth: { type: 'basic', username: '{{username}}', password: '{{password}}' },
        variables: [kv('username', ''), kv('password', '', { secret: true })],
      };
    if (s === 'bearer') {
      const v = variableName(name, 'Token');
      return { auth: { type: 'bearer', token: `{{${v}}}`, prefix: 'Bearer' }, variables: [kv(v, '', { secret: true })] };
    }
    if (s === 'digest')
      return {
        auth: { type: 'digest', username: '{{username}}', password: '{{password}}' },
        variables: [kv('username', ''), kv('password', '', { secret: true })],
      };
    w.add('unsupported-feature', `HTTP auth scheme "${s}" is not supported.`, name, 'securitySchemes');
    return undefined;
  }
  if (type === 'apiKey') {
    const v = variableName(name, '');
    const where = str(scheme.in);
    if (where === 'cookie') w.add('converted', `API key "${name}" sent in a cookie was mapped to a header API key named Cookie.`, name, 'securitySchemes');
    return {
      auth: {
        type: 'apikey',
        key: where === 'cookie' ? 'Cookie' : str(scheme.name),
        value: where === 'cookie' ? `${str(scheme.name)}={{${v}}}` : `{{${v}}}`,
        in: where === 'query' ? 'query' : 'header',
      },
      variables: [kv(v, '', { secret: true })],
    };
  }
  if (type === 'oauth2' || type === 'openIdConnect') {
    const flows = isObject(scheme.flows) ? scheme.flows : {};
    const scopesOf = (f: unknown) => (isObject(f) && isObject(f.scopes) ? Object.keys(f.scopes).join(' ') : '');
    let grantType: Extract<Auth, { type: 'oauth2' }>['grantType'] = 'authorization_code';
    let flow: JsonObject = {};
    if (isObject(flows.authorizationCode)) flow = flows.authorizationCode;
    else if (isObject(flows.clientCredentials)) {
      flow = flows.clientCredentials;
      grantType = 'client_credentials';
    } else if (isObject(flows.password)) {
      flow = flows.password;
      grantType = 'password';
    } else if (isObject(flows.implicit)) {
      flow = flows.implicit;
      w.add('converted', `OAuth 2.0 implicit flow of "${name}" is not supported; authorization code (PKCE) used.`, name, 'securitySchemes');
    }
    if (type === 'openIdConnect')
      w.add('converted', `OpenID Connect scheme "${name}" mapped to OAuth 2.0; fill in the endpoints from ${str(scheme.openIdConnectUrl) || 'the discovery document'}.`, name, 'securitySchemes');
    const vars = [kv('clientId', ''), kv('clientSecret', '', { secret: true })];
    if (grantType === 'password') vars.push(kv('username', ''), kv('password', '', { secret: true }));
    return {
      auth: {
        type: 'oauth2',
        grantType,
        authUrl: str(flow.authorizationUrl),
        tokenUrl: str(flow.tokenUrl),
        deviceAuthUrl: '',
        clientId: '{{clientId}}',
        clientSecret: '{{clientSecret}}',
        username: grantType === 'password' ? '{{username}}' : '',
        password: grantType === 'password' ? '{{password}}' : '',
        scope: scopesOf(flow),
        audience: '',
        redirectUri: 'http://127.0.0.1:0/callback',
        usePkce: true,
        clientAuthentication: 'body',
        tokenPrefix: 'Bearer',
        autoRefresh: true,
        extraParams: [],
      },
      variables: vars,
    };
  }
  if (type === 'mutualTLS')
    return { auth: { type: 'clientcert', certPath: '', keyPath: '', pfxPath: '', passphrase: '' }, variables: [] };
  w.add('unsupported-feature', `Security scheme type "${type}" is not supported.`, name, 'securitySchemes');
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

function serverUrl(server: JsonObject): string {
  let url = str(server.url);
  const vars = isObject(server.variables) ? server.variables : {};
  url = url.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const v = vars[name];
    return isObject(v) && v.default !== undefined ? str(v.default) : `{{${name}}}`;
  });
  return url.replace(/\/+$/, '');
}

function schemaDocs(label: string, schema: unknown): string {
  if (!isObject(schema) || Object.keys(schema).length === 0) return '';
  let json = JSON.stringify(schema, null, 2);
  if (json.length > 4000) json = `${json.slice(0, 4000)}\n... (truncated)`;
  return `\n\n**${label}**\n\n\`\`\`json\n${json}\n\`\`\``;
}

function bodyFromRequestBody(rb: JsonObject, w: Warnings, loc: string): { body: RequestBody; contentType?: string } {
  const content = isObject(rb.content) ? rb.content : {};
  const types = Object.keys(content);
  if (!types.length) return { body: { mode: 'none' } };
  const pick = types.find((t) => /json/i.test(t)) ?? types[0] ?? '';
  const media = isObject(content[pick]) ? (content[pick] as JsonObject) : {};
  const ex = mediaExample(media);
  if (types.length > 1) w.add('info', `Request body offers ${types.length} content types; "${pick}" was used.`, loc, 'requestBody.content');
  const lower = pick.toLowerCase();
  if (lower.includes('json')) return { body: { mode: 'json', text: ex === undefined || ex === null ? '' : JSON.stringify(ex, null, 2) }, contentType: pick };
  const schema = isObject(media.schema) ? media.schema : {};
  const props = isObject(schema.properties) ? schema.properties : {};
  if (lower === 'application/x-www-form-urlencoded') {
    const exObj = isObject(ex) ? ex : {};
    return { body: { mode: 'urlencoded', fields: Object.keys(props).map((k) => kv(k, str(exObj[k]))) }, contentType: pick };
  }
  if (lower.startsWith('multipart/')) {
    const exObj = isObject(ex) ? ex : {};
    const parts: MultipartPart[] = Object.entries(props).map(([k, p]) => {
      const isFile = isObject(p) && (p.format === 'binary' || p.format === 'base64' || p.contentMediaType !== undefined);
      return isFile ? { id: newId(), key: k, enabled: true, type: 'file', value: '', filePath: '' } : { id: newId(), key: k, enabled: true, type: 'text', value: str(exObj[k]) };
    });
    return { body: { mode: 'multipart', parts }, contentType: pick };
  }
  if (lower.includes('xml')) {
    if (typeof ex !== 'string') w.add('info', 'XML request example could not be generated from the schema; body left empty.', loc, 'requestBody');
    return { body: { mode: 'xml', text: typeof ex === 'string' ? ex : '' }, contentType: pick };
  }
  if (lower === 'application/octet-stream' || schema.format === 'binary') return { body: { mode: 'binary', filePath: '', contentType: pick }, contentType: pick };
  return { body: { mode: 'text', text: typeof ex === 'string' ? ex : ex === null || ex === undefined ? '' : JSON.stringify(ex, null, 2), contentType: pick }, contentType: pick };
}

/** Operation key used for matching during refresh. */
export function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function importOpenApi(input: unknown, opts: OpenApiImportOptions = {}): ImportResult {
  const doc = typeof input === 'string' ? parseSpecText(input) : input;
  if (isSwagger2(doc))
    throw importError('Swagger/OpenAPI 2.0 documents are not supported.', 'Convert the document to OpenAPI 3.x (e.g. with swagger2openapi) and import it again.');
  if (!isOpenApi(doc) || !isObject(doc)) throw importError('Not an OpenAPI 3.x document.');
  const w = new Warnings('openapi');
  const resolver = new RefResolver(doc, w);
  const info = isObject(doc.info) ? doc.info : {};
  const title = str(info.title) || 'OpenAPI';
  const groupByTags = opts.groupByTags !== false;

  const servers = asArray(doc.servers).filter(isObject);
  const firstServer = servers[0] ? serverUrl(servers[0]) : '';
  if (!servers.length) w.add('info', 'The document declares no servers; set the "baseUrl" variable manually.', title, 'servers');
  else if (firstServer.startsWith('/')) w.add('info', `Server URL "${firstServer}" is relative; prefix it with the API host in the environment.`, title, 'servers');

  const components = isObject(doc.components) ? doc.components : {};
  const schemes = isObject(components.securitySchemes) ? (resolver.deref(components.securitySchemes) as JsonObject) : {};
  const schemeAuth = new Map<string, SecurityPlaceholder | undefined>();
  const authFor = (requirement: unknown): SecurityPlaceholder | undefined | 'none' => {
    const reqs = asArray(requirement).filter(isObject);
    if (Array.isArray(requirement) && reqs.length === 0) return 'none';
    const first = reqs[0];
    if (!first) return undefined;
    const names = Object.keys(first);
    if (names.length === 0) return 'none';
    if (names.length > 1) w.add('converted', `Combined security requirement (${names.join(' + ')}) is not supported; only "${names[0]}" was applied.`, title, 'security');
    const n = names[0] ?? '';
    if (!schemeAuth.has(n)) schemeAuth.set(n, securitySchemeToAuth(n, schemes[n], w));
    return schemeAuth.get(n);
  };

  const globalSec = authFor(doc.security);
  const placeholderVars = new Map<string, KeyValue>();
  const addPlaceholders = (p: SecurityPlaceholder | undefined | 'none') => {
    if (p && p !== 'none') for (const v of p.variables) if (!placeholderVars.has(v.key)) placeholderVars.set(v.key, v);
  };
  addPlaceholders(globalSec);

  const b = new CollectionBuilder({
    name: title,
    description: [str(info.description), info.version ? `Version: ${str(info.version)}` : ''].filter(Boolean).join('\n\n'),
    variables: [kv('baseUrl', firstServer)],
    auth: globalSec && globalSec !== 'none' ? globalSec.auth : { type: 'none' },
    meta: {
      source: {
        type: 'openapi',
        ...(opts.fileName ? { location: opts.fileName } : {}),
        importedAt: nowIso(),
        hash: contentHash(doc),
      },
    },
  });

  // Folders by tag (declared tag order first).
  const tagDocs = new Map<string, string>();
  for (const t of asArray(doc.tags).filter(isObject)) tagDocs.set(str(t.name), str(t.description));
  const folders = new Map<string, Folder>();
  const folderFor = (tag: string | undefined): string | null => {
    if (!groupByTags || !tag) return null;
    let f = folders.get(tag);
    if (!f) {
      f = b.addFolder({ parentId: null, name: tag, description: tagDocs.get(tag) ?? '' });
      folders.set(tag, f);
    }
    return f.id;
  };
  const usedTags = new Set<string>();
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const item of Object.values(paths)) {
    if (!isObject(item)) continue;
    for (const m of OPENAPI_METHODS) {
      const op = item[m];
      if (isObject(op)) {
        const t = asArray(op.tags)[0];
        if (typeof t === 'string') usedTags.add(t);
      }
    }
  }
  if (groupByTags) for (const t of [...tagDocs.keys()].filter((t) => usedTags.has(t))) folderFor(t);

  let callbackCount = 0;
  for (const [path, rawItem] of Object.entries(paths)) {
    const pathItem = resolver.deref(rawItem);
    if (!isObject(pathItem)) continue;
    const pathParams = asArray(pathItem.parameters).filter(isObject);
    for (const method of OPENAPI_METHODS) {
      const op = pathItem[method];
      if (!isObject(op)) continue;
      const M = method.toUpperCase();
      const name = str(op.summary) || str(op.operationId) || `${M} ${path}`;
      const loc = `${title} / ${M} ${path}`;
      const merged = new Map<string, JsonObject>();
      for (const p of [...pathParams, ...asArray(op.parameters).filter(isObject)]) merged.set(`${str(p.in)}:${str(p.name)}`, p);
      const params: KeyValue[] = [];
      const headers: KeyValue[] = [];
      const cookies: KeyValue[] = [];
      const variables: KeyValue[] = [];
      for (const p of merged.values()) {
        const extra = { enabled: p.required === true || p.in === 'path', ...(p.description ? { description: str(p.description) } : {}) };
        const value = paramExample(p);
        const pname = str(p.name);
        if (p.in === 'query') params.push(kv(pname, value, extra));
        else if (p.in === 'header') {
          if (/^(accept|content-type|authorization)$/i.test(pname)) {
            w.add('info', `Header parameter "${pname}" is controlled by REQVYN (body/auth) and was skipped.`, loc, 'parameters');
            continue;
          }
          headers.push(kv(pname, value, extra));
        } else if (p.in === 'cookie') cookies.push(kv(pname, value, extra));
        else if (p.in === 'path') variables.push(kv(pname, value || '', { ...(p.description ? { description: str(p.description) } : {}) }));
      }
      let body: RequestBody = { mode: 'none' };
      let requestSchema: unknown;
      if (isObject(op.requestBody)) {
        const res = bodyFromRequestBody(op.requestBody, w, loc);
        body = res.body;
        const content = isObject(op.requestBody.content) ? op.requestBody.content : {};
        const media = res.contentType ? content[res.contentType] : undefined;
        requestSchema = isObject(media) ? media.schema : undefined;
      }
      // Auth
      let auth: Auth = { type: 'inherit' };
      if (op.security !== undefined) {
        const sec = authFor(op.security);
        addPlaceholders(sec);
        if (sec === 'none') auth = { type: 'none' };
        else if (sec && !(globalSec && globalSec !== 'none' && sec === globalSec)) auth = sec.auth;
      }
      // Responses -> docs + optional schema assertion
      const responses = isObject(op.responses) ? op.responses : {};
      const respLines: string[] = [];
      let successSchema: unknown;
      for (const [code, r] of Object.entries(responses)) {
        if (!isObject(r)) continue;
        respLines.push(`- \`${code}\` ${str(r.description)}`);
        const content = isObject(r.content) ? r.content : {};
        const jsonType = Object.keys(content).find((t) => /json/i.test(t));
        if (!successSchema && /^2/.test(code) && jsonType) {
          const media = content[jsonType];
          if (isObject(media) && isObject(media.schema)) successSchema = media.schema;
        }
      }
      const tests = emptyGroup();
      if (successSchema && opts.schemaAssertions !== false) {
        tests.items.push(
          createAssertion({
            source: 'json',
            path: '$',
            operator: 'schema',
            expected: JSON.stringify(successSchema),
            enabled: false,
            description: 'Response body matches the OpenAPI response schema',
          }),
        );
      }
      if (isObject(op.callbacks)) callbackCount += Object.keys(op.callbacks).length;
      const docs = [
        op.deprecated ? '> **Deprecated**' : '',
        str(op.description),
        respLines.length ? `**Responses**\n\n${respLines.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n') +
        schemaDocs('Request schema', requestSchema) +
        schemaDocs('Response schema', successSchema);
      const tag = asArray(op.tags)[0];
      const url = `{{baseUrl}}${path.replace(/\{([^}]+)\}/g, '{{$1}}')}`;
      const opServers = asArray(op.servers).length ? op.servers : asArray(pathItem.servers).length ? pathItem.servers : undefined;
      if (opServers) w.add('info', 'Operation-level servers are not applied; the collection "baseUrl" is used.', loc, 'servers');
      b.addRequest({
        parentId: folderFor(typeof tag === 'string' ? tag : undefined),
        name: op.deprecated ? `${name} (deprecated)` : name,
        method: M,
        url,
        params,
        headers,
        cookies,
        variables,
        body,
        auth,
        tests,
        docs: docs.trim(),
        meta: {
          openapi: {
            path,
            method: M,
            ...(op.operationId ? { operationId: str(op.operationId) } : {}),
            hash: contentHash({ path, method: M, parameters: [...merged.values()], op }),
          },
        },
      });
    }
  }
  if (callbackCount) w.add('unsupported-feature', `${callbackCount} callback definition(s) are not imported.`, title, 'callbacks');
  if (isObject(doc.webhooks) && Object.keys(doc.webhooks).length) w.add('unsupported-feature', 'Webhooks are not imported.', title, 'webhooks');

  const envVars = () => [...placeholderVars.values()].map((v) => ({ ...v, id: newId() }));
  const environments: Environment[] = servers.length
    ? servers.map((s, i) =>
        parseEnvironment(
          createEnvironment({
            name: str(s.description) || serverUrl(s) || `Server ${i + 1}`,
            variables: [kv('baseUrl', serverUrl(s)), ...envVars()],
          }),
        ),
      )
    : placeholderVars.size
      ? [parseEnvironment(createEnvironment({ name: title, variables: [kv('baseUrl', ''), ...envVars()] }))]
      : [];
  return { collections: [b.build()], environments, warnings: w.list };
}
