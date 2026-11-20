import { ancestorFolders, type Auth, type Collection, type Environment, type HttpRequest } from '@reqvyn/core';
import { slugify } from '@reqvyn/shared';
import { stringify as toYaml } from 'yaml';
import type { ExportResult, ExportWarning } from '../types.js';
import { splitUrl } from '../util.js';

/**
 * Export a collection as an OpenAPI 3.0 document. This is a best-effort description: request
 * examples become schemas/examples, folders become tags and auth becomes security schemes.
 * Scripts, tests and extractions have no OpenAPI equivalent.
 */

export interface OpenApiExportOptions {
  format?: 'json' | 'yaml';
  version?: string;
  /** Environments whose `baseUrl` values become servers. */
  environments?: Environment[];
}

type Obj = Record<string, unknown>;

const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/** Infer a JSON schema from an example value. */
export function inferSchema(v: unknown, depth = 0): Obj {
  if (depth > 20) return {};
  if (v === null) return { nullable: true };
  if (Array.isArray(v)) return { type: 'array', items: v.length ? inferSchema(v[0], depth + 1) : {} };
  switch (typeof v) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: Number.isInteger(v) ? 'integer' : 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      const props: Obj = {};
      for (const [k, x] of Object.entries(v as Obj)) props[k] = inferSchema(x, depth + 1);
      return { type: 'object', properties: props };
    }
    default:
      return {};
  }
}

function authToScheme(auth: Auth, w: ExportWarning[], location: string): { name: string; scheme: Obj } | undefined {
  switch (auth.type) {
    case 'inherit':
    case 'none':
      return undefined;
    case 'basic':
      return { name: 'basicAuth', scheme: { type: 'http', scheme: 'basic' } };
    case 'digest':
      return { name: 'digestAuth', scheme: { type: 'http', scheme: 'digest' } };
    case 'bearer':
      return { name: 'bearerAuth', scheme: { type: 'http', scheme: 'bearer' } };
    case 'jwt':
      if (auth.addTo === 'query') return { name: 'jwtQuery', scheme: { type: 'apiKey', in: 'query', name: auth.queryParam || 'token' } };
      return { name: 'jwtAuth', scheme: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } };
    case 'apikey': {
      const name = auth.key || 'X-API-Key';
      return { name: `apiKey_${slugify(name, 'key').replace(/-/g, '_')}`, scheme: { type: 'apiKey', in: auth.in, name } };
    }
    case 'oauth2': {
      const scopes: Obj = {};
      for (const s of auth.scope.split(/[\s,]+/).filter(Boolean)) scopes[s] = s;
      const flow: Obj = { scopes };
      if (auth.grantType === 'authorization_code' || auth.grantType === 'device_code') {
        if (auth.grantType === 'device_code') w.push({ code: 'converted', message: 'OAuth 2.0 device code flow is exported as authorization code.', location, field: 'auth' });
        flow.authorizationUrl = auth.authUrl || 'https://example.invalid/authorize';
        flow.tokenUrl = auth.tokenUrl || 'https://example.invalid/token';
        return { name: 'oauth2', scheme: { type: 'oauth2', flows: { authorizationCode: flow } } };
      }
      flow.tokenUrl = auth.tokenUrl || 'https://example.invalid/token';
      return { name: 'oauth2', scheme: { type: 'oauth2', flows: { [auth.grantType === 'password' ? 'password' : 'clientCredentials']: flow } } };
    }
    case 'awsv4':
      w.push({ code: 'converted', message: 'AWS Signature v4 is described as an Authorization header API key.', location, field: 'auth' });
      return { name: 'awsSigV4', scheme: { type: 'apiKey', in: 'header', name: 'Authorization', 'x-amazon-apigateway-authtype': 'awsSigv4' } };
    case 'clientcert':
      w.push({ code: 'unsupported-feature', message: 'Mutual TLS cannot be described in OpenAPI 3.0.', location, field: 'auth' });
      return undefined;
  }
}

/** Turn a REQVYN URL into an OpenAPI path ("{{baseUrl}}/users/{{id}}" -> "/users/{id}"). */
export function urlToPath(url: string): { path: string; pathParams: string[]; server?: string } {
  const { base } = splitUrl(url);
  let rest = base;
  let server: string | undefined;
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)(.*)$/i.exec(rest);
  if (m) {
    server = m[1];
    rest = m[2] ?? '';
  } else {
    const t = /^(\{\{[^{}]+\}\})(.*)$/.exec(rest);
    if (t) rest = t[2] ?? '';
  }
  const pathParams: string[] = [];
  let path = rest
    .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, n: string) => {
      const name = n.trim();
      pathParams.push(name);
      return `{${name}}`;
    })
    .replace(/(^|\/):([A-Za-z_][\w-]*)(?=\/|$)/g, (_m, pre: string, n: string) => {
      pathParams.push(n);
      return `${pre}{${n}}`;
    });
  if (!path.startsWith('/')) path = `/${path}`;
  return { path: path.replace(/\/{2,}/g, '/'), pathParams: [...new Set(pathParams)], ...(server ? { server } : {}) };
}

function requestBody(r: HttpRequest): Obj | undefined {
  const b = r.body;
  const example = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  switch (b.mode) {
    case 'none':
      return undefined;
    case 'json': {
      const ex = example(b.text);
      return { content: { 'application/json': ex !== undefined ? { schema: inferSchema(ex), example: ex } : { schema: {} } } };
    }
    case 'graphql':
      return { content: { 'application/json': { schema: { type: 'object', properties: { query: { type: 'string' }, variables: { type: 'object' } } }, example: { query: b.query } } } };
    case 'xml':
      return { content: { 'application/xml': { schema: { type: 'string' }, example: b.text } } };
    case 'text':
      return { content: { [(b.contentType || 'text/plain').split(';')[0] ?? 'text/plain']: { schema: { type: 'string' }, example: b.text } } };
    case 'urlencoded': {
      const props: Obj = {};
      for (const f of b.fields.filter((x) => x.key)) props[f.key] = { type: 'string', ...(f.value ? { example: f.value } : {}), ...(f.description ? { description: f.description } : {}) };
      return { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: props } } } };
    }
    case 'multipart': {
      const props: Obj = {};
      for (const p of b.parts.filter((x) => x.key)) props[p.key] = p.type === 'file' ? { type: 'string', format: 'binary' } : { type: 'string', ...(p.value ? { example: p.value } : {}) };
      return { content: { 'multipart/form-data': { schema: { type: 'object', properties: props } } } };
    }
    case 'binary':
      return { content: { [b.contentType || 'application/octet-stream']: { schema: { type: 'string', format: 'binary' } } } };
  }
}

export function exportOpenApi(c: Collection, opts: OpenApiExportOptions = {}): ExportResult<Obj> {
  const w: ExportWarning[] = [];
  const paths: Record<string, Obj> = {};
  const schemes: Obj = {};
  const servers = new Set<string>();
  const baseUrl = c.variables.find((v) => v.key === 'baseUrl')?.value;
  if (baseUrl && !/\{\{/.test(baseUrl)) servers.add(baseUrl);
  for (const env of opts.environments ?? []) {
    const v = env.variables.find((x) => x.key === 'baseUrl')?.value;
    if (v && !/\{\{/.test(v)) servers.add(v);
  }
  const usedOpIds = new Set<string>();
  const security = (auth: Auth, loc: string): Obj[] | undefined => {
    if (auth.type === 'none') return [];
    const s = authToScheme(auth, w, loc);
    if (!s) return undefined;
    schemes[s.name] = s.scheme;
    return [{ [s.name]: auth.type === 'oauth2' ? auth.scope.split(/[\s,]+/).filter(Boolean) : [] }];
  };
  const globalSecurity = security(c.auth, c.name);
  let skippedScripts = 0;
  for (const r of c.requests) {
    const loc = r.name;
    const method = r.method.toLowerCase();
    if (!METHODS.has(method)) {
      w.push({ code: 'unsupported-feature', message: `Method ${r.method} cannot be described in OpenAPI; request skipped.`, location: loc });
      continue;
    }
    const conv = urlToPath(r.url);
    const path = r.meta.openapi?.path ?? conv.path;
    if (conv.server && !baseUrl) servers.add(conv.server);
    const item = (paths[path] ??= {});
    if (item[method]) {
      w.push({ code: 'converted', message: `Duplicate operation ${r.method} ${path}; only the first request was exported.`, location: loc });
      continue;
    }
    const parameters: Obj[] = [];
    const pathVarNames = [...new Set([...conv.pathParams, ...[...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? '')])];
    for (const name of pathVarNames) {
      const v = r.variables.find((x) => x.key === name);
      parameters.push({ name, in: 'path', required: true, schema: { type: 'string' }, ...(v?.value ? { example: v.value } : {}), ...(v?.description ? { description: v.description } : {}) });
    }
    for (const p of [...splitUrl(r.url).params, ...r.params].filter((x) => x.key))
      parameters.push({ name: p.key, in: 'query', required: p.enabled, schema: { type: 'string' }, ...(p.value && !p.value.includes('{{') ? { example: p.value } : {}), ...(p.description ? { description: p.description } : {}) });
    for (const h of r.headers.filter((x) => x.key && !/^(content-type|authorization|accept)$/i.test(x.key)))
      parameters.push({ name: h.key, in: 'header', required: h.enabled, schema: { type: 'string' }, ...(h.value && !h.value.includes('{{') ? { example: h.value } : {}) });
    for (const ck of r.cookies.filter((x) => x.key)) parameters.push({ name: ck.key, in: 'cookie', required: ck.enabled, schema: { type: 'string' } });
    const top = ancestorFolders(c, r.parentId)[0];
    let operationId = r.meta.openapi?.operationId ?? slugify(`${r.method} ${r.name}`, 'operation').replace(/-([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase());
    while (usedOpIds.has(operationId)) operationId += '_';
    usedOpIds.add(operationId);
    const op: Obj = {
      summary: r.name,
      operationId,
      ...(top ? { tags: [top.name] } : {}),
      ...(r.docs ? { description: r.docs } : {}),
      ...(parameters.length ? { parameters } : {}),
    };
    const body = requestBody(r);
    if (body) op.requestBody = body;
    const schemaAssertion = r.tests.items.find((a) => a.kind === 'assert' && a.operator === 'schema');
    let responseSchema: unknown;
    if (schemaAssertion && schemaAssertion.kind === 'assert') {
      try {
        responseSchema = JSON.parse(schemaAssertion.expected);
      } catch {
        responseSchema = undefined;
      }
    }
    op.responses = { '200': { description: 'Successful response', ...(responseSchema ? { content: { 'application/json': { schema: responseSchema } } } : {}) } };
    if (r.auth.type !== 'inherit') {
      const sec = security(r.auth, loc);
      if (sec) op.security = sec;
    } else {
      const folderAuth = ancestorFolders(c, r.parentId)
        .reverse()
        .find((f) => f.auth.type !== 'inherit');
      if (folderAuth) {
        const sec = security(folderAuth.auth, loc);
        if (sec) op.security = sec;
      }
    }
    if (r.scripts.pre.trim() || r.scripts.post.trim() || r.extractions.length) skippedScripts++;
    item[method] = op;
  }
  if (skippedScripts) w.push({ code: 'unsupported-field', message: `Scripts and extractions of ${skippedScripts} request(s) have no OpenAPI equivalent and were not exported.`, field: 'scripts' });
  const tags = c.folders.filter((f) => f.parentId === null).map((f) => ({ name: f.name, ...(f.description ? { description: f.description } : {}) }));
  const doc: Obj = {
    openapi: '3.0.3',
    info: { title: c.name, version: opts.version ?? '1.0.0', ...(c.description ? { description: c.description } : {}) },
    ...(servers.size ? { servers: [...servers].map((url) => ({ url })) } : {}),
    ...(tags.length ? { tags } : {}),
    paths,
    ...(Object.keys(schemes).length ? { components: { securitySchemes: schemes } } : {}),
    ...(globalSecurity && globalSecurity.length ? { security: globalSecurity } : {}),
  };
  const text = opts.format === 'yaml' ? toYaml(doc, { lineWidth: 0 }) : JSON.stringify(doc, null, 2);
  return { text, data: doc, warnings: w };
}
