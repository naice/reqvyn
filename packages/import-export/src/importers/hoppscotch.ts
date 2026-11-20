import { createEnvironment, kv, parseEnvironment, type Auth, type KeyValue, type RequestBody } from '@reqvyn/core';
import { newId } from '@reqvyn/shared';
import type { ImportResult } from '../types.js';
import { CollectionBuilder, Warnings, asArray, importError, isObject, normalizeMethod, nowIso, parseQueryString, splitUrl, str, type JsonObject } from '../util.js';

/** Hoppscotch collection / environment JSON importer. Hoppscotch uses `<<var>>` templates. */

function isHoppCollectionObject(doc: unknown): boolean {
  return isObject(doc) && Array.isArray(doc.requests) && Array.isArray(doc.folders) && typeof doc.name === 'string';
}

export function isHoppscotchCollection(doc: unknown): boolean {
  if (Array.isArray(doc)) return doc.length > 0 && doc.every(isHoppCollectionObject);
  return isHoppCollectionObject(doc);
}

function isHoppEnvObject(doc: unknown): boolean {
  return isObject(doc) && typeof doc.name === 'string' && Array.isArray(doc.variables) && !('requests' in doc) && !('schemaVersion' in doc) && !('client' in doc) &&
    doc.variables.every((v) => isObject(v) && 'key' in v);
}

export function isHoppscotchEnvironment(doc: unknown): boolean {
  if (Array.isArray(doc)) return doc.length > 0 && doc.every(isHoppEnvObject);
  return isHoppEnvObject(doc);
}

export function convertHoppTemplate(s: string): string {
  return s.replace(/<<\s*([\w.$-]+)\s*>>/g, '{{$1}}');
}

function pairs(list: unknown): KeyValue[] {
  return asArray(list)
    .filter(isObject)
    .filter((p) => str(p.key) || str(p.value))
    .map((p) => kv(convertHoppTemplate(str(p.key)), convertHoppTemplate(str(p.value)), { enabled: p.active !== false, ...(p.description ? { description: str(p.description) } : {}) }));
}

function convertAuth(a: unknown, w: Warnings, loc: string): Auth {
  if (!isObject(a)) return { type: 'inherit' };
  const t = (k: string) => convertHoppTemplate(str(a[k]));
  if (a.authActive === false) return { type: 'none' };
  switch (str(a.authType)) {
    case 'inherit':
      return { type: 'inherit' };
    case 'none':
      return { type: 'none' };
    case 'basic':
      return { type: 'basic', username: t('username'), password: t('password') };
    case 'digest':
      return { type: 'digest', username: t('username'), password: t('password') };
    case 'bearer':
      return { type: 'bearer', token: t('token'), prefix: 'Bearer' };
    case 'api-key':
      return { type: 'apikey', key: t('key'), value: t('value'), in: a.addTo === 'QUERY_PARAMS' || a.addTo === 'Query params' ? 'query' : 'header' };
    case 'aws-signature':
      return {
        type: 'awsv4',
        accessKeyId: t('accessKey'),
        secretAccessKey: t('secretKey'),
        sessionToken: t('serviceToken'),
        region: t('region') || 'us-east-1',
        service: t('serviceName') || 'execute-api',
      };
    case 'oauth-2': {
      const g = isObject(a.grantTypeInfo) ? a.grantTypeInfo : a;
      const gt = (k: string) => convertHoppTemplate(str(g[k]));
      const grant = str(g.grantType);
      return {
        type: 'oauth2',
        grantType: grant === 'CLIENT_CREDENTIALS' ? 'client_credentials' : grant === 'PASSWORD' ? 'password' : 'authorization_code',
        authUrl: gt('authEndpoint') || t('authURL'),
        tokenUrl: gt('tokenEndpoint') || t('accessTokenURL'),
        deviceAuthUrl: '',
        clientId: gt('clientID') || t('clientID'),
        clientSecret: gt('clientSecret'),
        username: gt('username'),
        password: gt('password'),
        scope: gt('scopes') || t('scope'),
        audience: '',
        redirectUri: 'http://127.0.0.1:0/callback',
        usePkce: g.isPKCE === true,
        clientAuthentication: g.clientAuthentication === 'AS_BASIC_AUTH_HEADERS' ? 'basic' : 'body',
        tokenPrefix: 'Bearer',
        autoRefresh: true,
        extraParams: [],
      };
    }
    default:
      w.add('unsupported-feature', `Hoppscotch auth type "${str(a.authType)}" is not supported; auth set to none.`, loc, 'auth.authType');
      return { type: 'none' };
  }
}

function convertBody(body: unknown, w: Warnings, loc: string): RequestBody {
  if (!isObject(body) || !body.contentType) return { mode: 'none' };
  const ct = str(body.contentType).toLowerCase();
  const raw = body.body;
  if (ct === 'multipart/form-data') {
    return {
      mode: 'multipart',
      parts: asArray(raw)
        .filter(isObject)
        .map((p) => {
          const isFile = p.isFile === true;
          if (isFile) w.add('converted', `File field "${str(p.key)}" has no file path in the export; select the file again.`, loc, 'body');
          return isFile
            ? { id: newId(), key: str(p.key), enabled: p.active !== false, type: 'file' as const, value: '' }
            : { id: newId(), key: str(p.key), enabled: p.active !== false, type: 'text' as const, value: convertHoppTemplate(str(p.value)) };
        }),
    };
  }
  const text = convertHoppTemplate(str(raw));
  if (ct === 'application/x-www-form-urlencoded') {
    // Stored as "key: value" lines in Hoppscotch.
    const fields = text.includes('\n') || /^[^=&]+:\s/.test(text)
      ? text
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => {
            const disabled = l.trim().startsWith('#');
            const s = disabled ? l.trim().slice(1) : l;
            const idx = s.indexOf(':');
            return kv(s.slice(0, idx < 0 ? undefined : idx).trim(), idx < 0 ? '' : s.slice(idx + 1).trim(), { enabled: !disabled });
          })
      : parseQueryString(text);
    return { mode: 'urlencoded', fields };
  }
  if (ct.includes('json')) return { mode: 'json', text };
  if (ct.includes('xml')) return { mode: 'xml', text };
  if (ct === 'application/octet-stream') {
    w.add('converted', 'Binary body has no file path in the export; select the file again.', loc, 'body');
    return { mode: 'binary', filePath: '' };
  }
  return { mode: 'text', text, contentType: ct };
}

export function importHoppscotch(doc: unknown, fileName?: string): ImportResult {
  if (!isHoppscotchCollection(doc)) throw importError('Not a Hoppscotch collection.');
  const list = (Array.isArray(doc) ? doc : [doc]).filter(isObject);
  const w = new Warnings('hoppscotch');
  const collections = list.map((col) => {
    const name = str(col.name) || 'Hoppscotch Collection';
    const b = new CollectionBuilder({
      name,
      headers: pairs(col.headers),
      variables: pairs(col.variables),
      meta: { source: { type: 'hoppscotch', ...(fileName ? { location: fileName } : {}), importedAt: nowIso() } },
    });
    const colAuth = convertAuth(col.auth, w, name);
    b.collection.auth = colAuth.type === 'inherit' ? { type: 'none' } : colAuth;
    const addRequests = (requests: unknown, parentId: string | null, path: string) => {
      for (const r of asArray(requests).filter(isObject)) {
        const rname = str(r.name) || 'Request';
        const loc = `${path} / ${rname}`;
        if (isObject(r.query) || 'query' in r) {
          // GraphQL requests exported from the GraphQL tab.
          b.addRequest({ parentId, name: rname, method: 'POST', url: convertHoppTemplate(str(r.url)), headers: pairs(r.headers), auth: convertAuth(r.auth, w, loc), body: { mode: 'graphql', query: str(r.query), variables: str(r.variables) } });
          continue;
        }
        const { base, params: urlParams } = splitUrl(convertHoppTemplate(str(r.endpoint)));
        const pre = convertHoppTemplate(str(r.preRequestScript));
        const post = convertHoppTemplate(str(r.testScript));
        if (/\bpw\./.test(pre + post)) w.add('script-needs-adaptation', 'Scripts use the Hoppscotch "pw.*" API and were imported as-is.', loc, 'testScript');
        const params = pairs(r.params);
        b.addRequest({
          parentId,
          name: rname,
          method: normalizeMethod(r.method),
          url: base,
          params: params.length ? params : urlParams,
          headers: pairs(r.headers),
          body: convertBody(r.body, w, loc),
          auth: convertAuth(r.auth, w, loc),
          variables: pairs(r.requestVariables),
          scripts: { pre, post },
        });
        if (asArray(r.responses).length || (isObject(r.responses) && Object.keys(r.responses).length))
          w.add('unsupported-field', 'Saved responses were not imported.', loc, 'responses');
      }
    };
    const walk = (c: JsonObject, parentId: string | null, path: string) => {
      addRequests(c.requests, parentId, path);
      for (const f of asArray(c.folders).filter(isObject)) {
        const fname = str(f.name) || 'Folder';
        const loc = `${path} / ${fname}`;
        const folder = b.addFolder({ parentId, name: fname, headers: pairs(f.headers), auth: convertAuth(f.auth, w, loc), variables: pairs(f.variables) });
        walk(f, folder.id, loc);
      }
    };
    walk(col, null, name);
    return b.build();
  });
  return { collections, environments: [], warnings: w.list };
}

export function importHoppscotchEnvironment(doc: unknown): ImportResult {
  if (!isHoppscotchEnvironment(doc)) throw importError('Not a Hoppscotch environment.');
  const w = new Warnings('hoppscotch-environment');
  const list = (Array.isArray(doc) ? doc : [doc]).filter(isObject);
  const environments = list.map((e) =>
    parseEnvironment(
      createEnvironment({
        name: str(e.name) || 'Environment',
        variables: asArray(e.variables)
          .filter(isObject)
          .map((v) => kv(str(v.key), v.secret ? '' : str(v.value ?? v.initialValue ?? v.currentValue), v.secret ? { secret: true } : {})),
      }),
    ),
  );
  if (list.some((e) => asArray(e.variables).some((v) => isObject(v) && v.secret)))
    w.add('secret', 'Secret environment values are not exported by Hoppscotch; re-enter them in REQVYN.');
  return { collections: [], environments, warnings: w.list };
}
