import { createEnvironment, kv, parseEnvironment, type Auth, type Environment, type KeyValue, type RequestBody } from '@reqvyn/core';
import { newId } from '@reqvyn/shared';
import type { ImportResult } from '../types.js';
import {
  CollectionBuilder,
  Warnings,
  asArray,
  convertColonPathParams,
  flattenObject,
  importError,
  isObject,
  normalizeMethod,
  nowIso,
  parseJsonSafe,
  splitUrl,
  str,
  type JsonObject,
} from '../util.js';

/** Insomnia v4 export (`__export_format: 4`) importer. */

export function isInsomniaExport(doc: unknown): boolean {
  return isObject(doc) && doc._type === 'export' && Array.isArray(doc.resources);
}

/** Convert Insomnia/Nunjucks templates `{{ _.name }}` -> `{{name}}`; reports `{% tag %}` usage. */
export function convertInsomniaTemplate(s: string, w: Warnings, location: string, field: string): string {
  const out = s.replace(/\{\{\s*(?:_\.)?([\w.$-]+)\s*\}\}/g, (_m, name: string) => `{{${name}}}`);
  if (/\{%[\s\S]*?%\}/.test(out))
    w.add('unsupported-feature', 'Insomnia template tags ({% ... %}) such as response references are not supported and were kept as text.', location, field);
  return out;
}

function pairs(list: unknown, w: Warnings, loc: string, field: string): KeyValue[] {
  return asArray(list)
    .filter(isObject)
    .filter((p) => str(p.name) || str(p.value))
    .map((p) =>
      kv(convertInsomniaTemplate(str(p.name), w, loc, field), convertInsomniaTemplate(str(p.value), w, loc, field), {
        enabled: p.disabled !== true,
        ...(p.description ? { description: str(p.description) } : {}),
      }),
    );
}

function convertAuth(a: unknown, w: Warnings, loc: string): Auth {
  if (!isObject(a) || !a.type) return { type: 'inherit' };
  const t = (k: string) => convertInsomniaTemplate(str(a[k]), w, loc, `authentication.${k}`);
  if (a.disabled === true) return { type: 'none' };
  switch (str(a.type)) {
    case 'none':
      return { type: 'none' };
    case 'basic':
      return { type: 'basic', username: t('username'), password: t('password') };
    case 'digest':
      return { type: 'digest', username: t('username'), password: t('password') };
    case 'bearer':
      return { type: 'bearer', token: t('token'), prefix: str(a.prefix) || 'Bearer' };
    case 'apikey':
      return { type: 'apikey', key: t('key'), value: t('value'), in: a.addTo === 'queryParams' ? 'query' : 'header' };
    case 'iam':
      return {
        type: 'awsv4',
        accessKeyId: t('accessKeyId'),
        secretAccessKey: t('secretAccessKey'),
        sessionToken: t('sessionToken'),
        region: t('region') || 'us-east-1',
        service: t('service') || 'execute-api',
      };
    case 'oauth2': {
      const g = str(a.grantType);
      const grantType = g === 'client_credentials' ? 'client_credentials' : g === 'password' ? 'password' : 'authorization_code';
      if (g === 'implicit') w.add('converted', 'OAuth 2.0 implicit grant is not supported; authorization_code used.', loc, 'authentication.grantType');
      return {
        type: 'oauth2',
        grantType,
        authUrl: t('authorizationUrl'),
        tokenUrl: t('accessTokenUrl'),
        deviceAuthUrl: '',
        clientId: t('clientId'),
        clientSecret: t('clientSecret'),
        username: t('username'),
        password: t('password'),
        scope: t('scope'),
        audience: t('audience'),
        redirectUri: t('redirectUrl') || 'http://127.0.0.1:0/callback',
        usePkce: a.usePkce === true,
        clientAuthentication: a.credentialsInBody === false ? 'basic' : 'body',
        tokenPrefix: str(a.tokenPrefix) || 'Bearer',
        autoRefresh: true,
        extraParams: [],
      };
    }
    default:
      w.add('unsupported-feature', `Insomnia auth type "${str(a.type)}" is not supported; auth set to none.`, loc, 'authentication.type');
      return { type: 'none' };
  }
}

function convertBody(body: unknown, w: Warnings, loc: string): RequestBody {
  if (!isObject(body) || Object.keys(body).length === 0) return { mode: 'none' };
  const mime = str(body.mimeType).toLowerCase();
  const text = convertInsomniaTemplate(str(body.text), w, loc, 'body.text');
  if (body.fileName) return { mode: 'binary', filePath: str(body.fileName), ...(mime ? { contentType: mime } : {}) };
  if (mime === 'application/x-www-form-urlencoded') return { mode: 'urlencoded', fields: pairs(body.params, w, loc, 'body.params') };
  if (mime === 'multipart/form-data')
    return {
      mode: 'multipart',
      parts: asArray(body.params)
        .filter(isObject)
        .map((p) => {
          const isFile = p.type === 'file';
          return {
            id: newId(),
            key: str(p.name),
            enabled: p.disabled !== true,
            type: isFile ? ('file' as const) : ('text' as const),
            value: isFile ? '' : convertInsomniaTemplate(str(p.value), w, loc, 'body.params'),
            ...(isFile ? { filePath: str(p.fileName) } : {}),
          };
        }),
    };
  if (mime === 'application/graphql') {
    const parsed = parseJsonSafe(text);
    if (isObject(parsed)) {
      const vars = parsed.variables;
      return { mode: 'graphql', query: str(parsed.query), variables: vars === undefined || vars === null ? '' : typeof vars === 'string' ? vars : JSON.stringify(vars, null, 2) };
    }
    return { mode: 'graphql', query: text, variables: '' };
  }
  if (mime.includes('json')) return { mode: 'json', text };
  if (mime.includes('xml')) return { mode: 'xml', text };
  if (!mime && !text) return { mode: 'none' };
  return { mode: 'text', text, ...(mime ? { contentType: mime } : {}) };
}

function envVariables(data: unknown): KeyValue[] {
  return flattenObject(data).map(([k, v]) => kv(k, v));
}

export function importInsomnia(doc: unknown, fileName?: string): ImportResult {
  if (!isInsomniaExport(doc) || !isObject(doc)) throw importError('Not an Insomnia v4 export.');
  const w = new Warnings('insomnia');
  if (doc.__export_format !== 4) w.add('converted', `Insomnia export format ${str(doc.__export_format)} is not v4; import attempted anyway.`);
  const resources = asArray(doc.resources).filter(isObject);
  const byParent = new Map<string, JsonObject[]>();
  for (const r of resources) {
    const p = str(r.parentId);
    byParent.set(p, [...(byParent.get(p) ?? []), r]);
  }
  const sortChildren = (list: JsonObject[]) =>
    [...list].sort((a, b) => Number(a.metaSortKey ?? 0) - Number(b.metaSortKey ?? 0));

  const workspaces = resources.filter((r) => r._type === 'workspace');
  // Exports without a workspace resource: treat top-level parents as an implicit workspace.
  const roots: JsonObject[] = workspaces.length
    ? workspaces
    : [...new Set(resources.filter((r) => r._type === 'request' || r._type === 'request_group').map((r) => str(r.parentId)))]
        .filter((pid) => !resources.some((r) => str(r._id) === pid))
        .map((pid) => ({ _id: pid, _type: 'workspace', name: 'Insomnia Collection' }));

  const result: ImportResult = { collections: [], environments: [], warnings: w.list };
  const skippedTypes = new Map<string, number>();

  for (const ws of roots) {
    const wsName = str(ws.name) || 'Insomnia Collection';
    if (ws.scope === 'design') w.add('info', 'Design workspace imported; the API spec document itself is not imported (import it separately as OpenAPI).', wsName);
    const b = new CollectionBuilder({
      name: wsName,
      description: str(ws.description),
      meta: { source: { type: 'insomnia', ...(fileName ? { location: fileName } : {}), importedAt: nowIso() } },
    });

    const walk = (parentInsomniaId: string, parentId: string | null, path: string) => {
      for (const r of sortChildren(byParent.get(parentInsomniaId) ?? [])) {
        const name = str(r.name) || 'Untitled';
        const loc = `${path} / ${name}`;
        if (r._type === 'request_group') {
          const folder = b.addFolder({
            parentId,
            name,
            description: str(r.description),
            variables: envVariables(r.environment),
            auth: convertAuth(r.authentication, w, loc),
            headers: pairs(r.headers, w, loc, 'headers'),
          });
          if (r.preRequestScript || r.afterResponseScript)
            w.add('unsupported-field', 'Folder scripts were not imported.', loc, 'preRequestScript');
          walk(str(r._id), folder.id, loc);
        } else if (r._type === 'request') {
          const rawUrl = convertInsomniaTemplate(str(r.url), w, loc, 'url');
          const { base, params: urlParams } = splitUrl(rawUrl);
          const conv = convertColonPathParams(base);
          const pathParams = asArray(r.pathParameters).filter(isObject);
          const pre = str(r.preRequestScript);
          const post = str(r.afterResponseScript);
          if (/\binsomnia\./.test(pre + post))
            w.add('script-needs-adaptation', 'Scripts use the Insomnia "insomnia.*" API and were imported as-is.', loc, 'preRequestScript');
          const settings: Record<string, boolean> = {};
          if (r.settingFollowRedirects === 'on') settings.followRedirects = true;
          if (r.settingFollowRedirects === 'off') settings.followRedirects = false;
          if (r.settingEncodeUrl === false) settings.encodeUrl = false;
          if (r.settingSendCookies === false) settings.useCookieJar = false;
          b.addRequest({
            parentId,
            name,
            method: normalizeMethod(r.method),
            url: conv.url,
            params: [...urlParams, ...pairs(r.parameters, w, loc, 'parameters')],
            headers: pairs(r.headers, w, loc, 'headers'),
            body: convertBody(r.body, w, loc),
            auth: convertAuth(r.authentication, w, loc),
            variables: conv.names.map((n) => kv(n, str(pathParams.find((p) => str(p.name) === n)?.value))),
            scripts: { pre, post },
            settings,
            docs: str(r.description),
          });
          w.unknownKeys(
            r,
            ['_id', '_type', 'parentId', 'name', 'url', 'method', 'body', 'parameters', 'headers', 'authentication', 'description', 'metaSortKey', 'modified', 'created', 'isPrivate', 'settingStoreCookies', 'settingSendCookies', 'settingDisableRenderRequestBody', 'settingEncodeUrl', 'settingRebuildPath', 'settingFollowRedirects', 'preRequestScript', 'afterResponseScript', 'pathParameters'],
            loc,
          );
        } else if (r._type !== 'environment' && r._type !== 'cookie_jar') {
          skippedTypes.set(str(r._type), (skippedTypes.get(str(r._type)) ?? 0) + 1);
        }
      }
    };
    walk(str(ws._id), null, wsName);

    // Environments: base environment (child of workspace) + sub-environments (children of base).
    const baseEnvs = (byParent.get(str(ws._id)) ?? []).filter((r) => r._type === 'environment');
    for (const base of baseEnvs) {
      const baseVars = envVariables(base.data);
      // Base environment variables apply to all requests -> collection variables.
      b.collection.variables.push(...baseVars);
      const subs = sortChildren((byParent.get(str(base._id)) ?? []).filter((r) => r._type === 'environment'));
      for (const sub of subs) {
        const env: Environment = parseEnvironment(
          createEnvironment({
            name: str(sub.name) || 'Environment',
            ...(sub.color ? { color: str(sub.color) } : {}),
            variables: envVariables(sub.data).map((v) => ({ ...v, ...(sub.isPrivate ? { secret: true } : {}) })),
          }),
        );
        result.environments.push(env);
      }
    }
    const jars = (byParent.get(str(ws._id)) ?? []).filter((r) => r._type === 'cookie_jar' && asArray(r.cookies).length);
    if (jars.length) w.add('unsupported-field', 'Cookie jar contents were not imported.', wsName, 'cookie_jar');
    result.collections.push(b.build());
  }
  for (const [type, n] of skippedTypes) {
    w.add('unsupported-feature', `${n} Insomnia resource(s) of type "${type}" are not supported and were not imported.`, undefined, type);
  }
  return result;
}
