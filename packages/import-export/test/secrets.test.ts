import { describe, expect, it } from 'vitest';
import { createCollection, createEnvironment, createFolder, createRequest, kv, parseCollection, type Collection } from '@reqvyn/core';
import { detectSecretValue, environmentTemplate, isLiteral, maskPreview, sanitizeCollection, sanitizeRequest, scanCollection, scanForSecrets } from '../src/index.js';

// Fake secret-shaped strings are assembled at runtime so that no token-like literal lives in the repo.
const FAKE_GH = `gh${'p'}_${'A1b2C3d4E5'.repeat(4)}`;
const BODY_GH = `gh${'p'}_${'Z9y8X7w6V5'.repeat(4)}`;
const FAKE_JWT = ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLWZha2UtdmFsdWU'].join('.');

function leaky(): Collection {
  const c = createCollection({
    name: 'Leaky',
    variables: [kv('baseUrl', 'https://l.example.test'), kv('clientSecret', 'col-secret-fake', { secret: true })],
    auth: { type: 'basic', username: 'admin', password: 'col-password-fake' },
  });
  const f = createFolder({ name: 'F', parentId: null, sortKey: 0, auth: { type: 'apikey', key: 'X-Key', value: 'folder-key-fake', in: 'header' } });
  c.folders.push(f);
  c.requests.push(
    createRequest({
      name: 'R1',
      parentId: f.id,
      sortKey: 0,
      method: 'GET',
      url: '{{baseUrl}}/a',
      params: [kv('api_key', 'query-key-fake'), kv('page', '1')],
      headers: [kv('Authorization', `Bearer ${FAKE_JWT}`), kv('X-Ref', '{{token}}'), kv('Accept', 'application/json')],
      cookies: [kv('session', 'cookie-fake')],
      auth: { type: 'bearer', token: FAKE_GH, prefix: 'Bearer' },
    }),
    createRequest({
      name: 'R2',
      parentId: null,
      sortKey: 1,
      method: 'POST',
      url: '{{baseUrl}}/b',
      auth: {
        type: 'oauth2',
        grantType: 'client_credentials',
        authUrl: '',
        tokenUrl: 'https://idp.test/token',
        deviceAuthUrl: '',
        clientId: 'client-id',
        clientSecret: 'oauth-secret-fake',
        username: '',
        password: '',
        scope: 'read',
        audience: '',
        redirectUri: 'http://127.0.0.1:0/callback',
        usePkce: false,
        clientAuthentication: 'body',
        tokenPrefix: 'Bearer',
        autoRefresh: true,
        extraParams: [],
      },
      body: { mode: 'json', text: `{"token":"${BODY_GH}"}` },
    }),
    createRequest({ name: 'R3', parentId: null, sortKey: 2, method: 'GET', url: '{{baseUrl}}/c', auth: { type: 'bearer', token: '{{token}}', prefix: 'Bearer' } }),
  );
  return parseCollection(c);
}

const LITERALS = ['col-secret-fake', 'col-password-fake', 'folder-key-fake', 'query-key-fake', FAKE_JWT, 'cookie-fake', FAKE_GH, 'oauth-secret-fake'];

describe('secret detection', () => {
  it('detects secret-shaped values and ignores templates', () => {
    expect(detectSecretValue(FAKE_GH)?.reason).toMatch(/GitHub/);
    expect(detectSecretValue(`Bearer ${FAKE_JWT}`)?.reason).toMatch(/JWT/);
    expect(detectSecretValue('hello world')).toBeUndefined();
    expect(isLiteral('{{token}}')).toBe(false);
    expect(isLiteral('Bearer abc')).toBe(true);
    expect(maskPreview('short')).not.toContain('short');
    expect(maskPreview(FAKE_GH)).not.toContain(FAKE_GH.slice(4));
  });

  it('scans collections and never reveals full values', () => {
    const findings = scanCollection(leaky());
    const fields = findings.map((f) => `${f.location}|${f.field}`);
    expect(fields.some((f) => f.includes('auth'))).toBe(true);
    expect(fields.some((f) => f.includes('headers.Authorization'))).toBe(true);
    expect(fields.some((f) => f.includes('api_key'))).toBe(true);
    expect(fields.some((f) => f.includes('body'))).toBe(true);
    const json = JSON.stringify(findings);
    for (const s of [...LITERALS, BODY_GH]) expect(json).not.toContain(s);
    expect(scanForSecrets([leaky(), createEnvironment({ name: 'E', variables: [kv('t', 'x', { secret: true })] })]).length).toBeGreaterThan(findings.length);
  });
});

describe('secret blanking', () => {
  it('blanks every literal secret but keeps templates and ordinary values', () => {
    const { collection, removed } = sanitizeCollection(leaky());
    const text = JSON.stringify(collection);
    for (const s of LITERALS) expect(text, s).not.toContain(s);
    expect(text).toContain('{{token}}');
    // Bodies are reported by the scanner but never rewritten.
    expect(text).toContain(BODY_GH);
    expect(text).toContain('application/json');
    expect(text).toContain('client-id');
    expect(text).toContain('admin');
    expect(collection.requests.find((r) => r.name === 'R3')!.auth).toMatchObject({ token: '{{token}}' });
    expect(collection.requests.find((r) => r.name === 'R1')!.params.find((p) => p.key === 'page')!.value).toBe('1');
    expect(removed.length).toBeGreaterThanOrEqual(LITERALS.length - 1);
    expect(removed.every((r) => r.removed)).toBe(true);
    expect(() => parseCollection(collection)).not.toThrow();
  });

  it('keeps secrets only with includeSecrets, and can keep sensitive headers', () => {
    const kept = sanitizeCollection(leaky(), { includeSecrets: true });
    expect(JSON.stringify(kept.collection)).toContain(FAKE_GH);
    const r = leaky().requests.find((x) => x.name === 'R1')!;
    const noHeaderRedaction = sanitizeRequest(r, { redactSensitiveHeaders: false });
    expect(noHeaderRedaction.request.headers.find((h) => h.key === 'Authorization')!.value).toContain(FAKE_JWT);
    expect(noHeaderRedaction.request.auth).toMatchObject({ token: '' });
  });

  it('creates environment templates', () => {
    const env = createEnvironment({
      name: 'Prod',
      variables: [kv('host', 'https://prod.test'), kv('password', 'plain-password-fake'), kv('tok', FAKE_GH), kv('s', 'marked-secret-fake', { secret: true }), kv('ref', '{{other}}')],
    });
    const t = environmentTemplate(env);
    const vals = Object.fromEntries(t.environment.variables.map((v) => [v.key, v.value]));
    expect(vals).toEqual({ host: 'https://prod.test', password: '', tok: '', s: '', ref: '{{other}}' });
    expect(t.removed).toHaveLength(3);
    const withValues = environmentTemplate(env, { includeEnvironmentValues: true });
    expect(withValues.environment.variables.find((v) => v.key === 'password')!.value).toBe('plain-password-fake');
    expect(withValues.environment.variables.find((v) => v.key === 's')!.value).toBe('');
    const all = environmentTemplate(env, { includeEnvironmentValues: true, includeSecrets: true });
    expect(all.environment.variables.find((v) => v.key === 's')!.value).toBe('marked-secret-fake');
    expect(all.removed).toHaveLength(0);
  });
});
