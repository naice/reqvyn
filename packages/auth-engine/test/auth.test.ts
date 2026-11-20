import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, createVerify, createHmac } from 'node:crypto';
import { sendRequest } from '@reqvyn/http-engine';
import { AuthSchema, type Auth } from '@reqvyn/core';
import {
  applyAuth,
  answerChallenge,
  signJwt,
  decodeJwt,
  signAwsV4,
  parseDigestChallenge,
  buildDigestAuthorization,
  getOAuth2Token,
  getTokenStatus,
  clearToken,
  MemoryTokenStore,
  tokenCacheKey,
  resolveOAuth2,
  type AuthContext,
  type ConcreteAuth,
} from '../src/index.js';
import { startMockServer, TLS_DIR, type MockServer } from '../../../tests/helpers/mockServer.js';

let srv: MockServer;
beforeAll(async () => {
  srv = await startMockServer();
});
afterAll(() => srv.close());

const ctx = (extra: Partial<AuthContext> = {}): AuthContext => ({ resolve: (s) => s.replace('{{pw}}', 'secret'), ...extra });
const parse = (a: unknown) => AuthSchema.parse(a) as ConcreteAuth;

describe('simple auth types', () => {
  const base = { method: 'GET', url: 'https://api.test/x', headers: [] as Array<[string, string]> };

  it('basic', async () => {
    const r = await applyAuth(parse({ type: 'basic', username: 'u', password: '{{pw}}' }), base, ctx());
    expect(r.headers).toContainEqual(['Authorization', 'Basic ' + Buffer.from('u:secret').toString('base64')]);
  });

  it('bearer with custom prefix', async () => {
    const r = await applyAuth(parse({ type: 'bearer', token: 'abc', prefix: 'Token' }), base, ctx());
    expect(r.headers).toContainEqual(['Authorization', 'Token abc']);
  });

  it('api key in header and query', async () => {
    const h = await applyAuth(parse({ type: 'apikey', key: 'X-Api-Key', value: 'k', in: 'header' }), base, ctx());
    expect(h.headers).toContainEqual(['X-Api-Key', 'k']);
    const q = await applyAuth(parse({ type: 'apikey', key: 'api_key', value: 'k v', in: 'query' }), base, ctx());
    expect(new URL(q.url).searchParams.get('api_key')).toBe('k v');
  });

  it('explicit Authorization header wins', async () => {
    const r = await applyAuth(parse({ type: 'bearer', token: 'abc' }), { ...base, headers: [['authorization', 'Custom x']] }, ctx());
    expect(r.headers).toEqual([['authorization', 'Custom x']]);
  });

  it('client certificate loads files', async () => {
    const r = await applyAuth(parse({ type: 'clientcert', certPath: 'client.crt', keyPath: 'client.key' }), base, ctx({ baseDir: TLS_DIR }));
    expect(r.tls?.cert?.toString()).toContain('BEGIN CERTIFICATE');
    await expect(applyAuth(parse({ type: 'clientcert', certPath: 'missing.crt', keyPath: 'x' }), base, ctx({ baseDir: TLS_DIR }))).rejects.toThrow(/Cannot read/);
  });
});

describe('JWT', () => {
  it('signs HS256 verifiably', () => {
    const token = signJwt({ algorithm: 'HS256', secret: 'shh', payload: '{"sub":"1"}', expiresInSeconds: 60, now: 1_000_000 });
    const [h, p, s] = token.split('.');
    expect(createHmac('sha256', 'shh').update(`${h}.${p}`).digest('base64url')).toBe(s);
    expect(decodeJwt(token)?.payload).toEqual({ sub: '1', iat: 1000, exp: 1060 });
  });

  it('signs RS256 and ES256', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const t1 = signJwt({ algorithm: 'RS256', secret: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), payload: '{}' });
    const [h1, p1, s1] = t1.split('.');
    expect(createVerify('SHA256').update(`${h1}.${p1}`).verify(rsa.publicKey, Buffer.from(s1!, 'base64url'))).toBe(true);
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const t2 = signJwt({ algorithm: 'ES256', secret: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), payload: '{}' });
    const [h2, p2, s2] = t2.split('.');
    expect(Buffer.from(s2!, 'base64url')).toHaveLength(64);
    expect(createVerify('SHA256').update(`${h2}.${p2}`).verify({ key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s2!, 'base64url'))).toBe(true);
  });

  it('rejects invalid payload JSON', () => {
    expect(() => signJwt({ algorithm: 'HS256', secret: 'x', payload: '{bad' })).toThrow(/not valid JSON/);
  });
});

describe('AWS SigV4', () => {
  it('matches the AWS reference signature (get-vanilla test vector)', () => {
    // From the AWS SigV4 test suite ("get-vanilla").
    const headers = signAwsV4(
      { method: 'GET', url: 'https://example.amazonaws.com/', headers: [], payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service' },
      new Date('2015-08-30T12:36:00Z'),
    );
    const auth = headers.find(([k]) => k === 'Authorization')![1];
    expect(auth).toContain('Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request');
    expect(auth).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
    expect(auth).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(headers).toContainEqual(['X-Amz-Date', '20150830T123600Z']);
  });

  it('is deterministic and includes the session token', () => {
    const sign = () =>
      signAwsV4(
        { method: 'POST', url: 'https://example.amazonaws.com/path?b=2&a=1', headers: [['Content-Type', 'application/json']], payloadHash: 'abc' },
        { accessKeyId: 'A', secretAccessKey: 'B', region: 'eu-central-1', service: 'execute-api', sessionToken: 'T' },
        new Date('2024-01-01T00:00:00Z'),
      );
    expect(sign()).toEqual(sign());
    expect(sign()).toContainEqual(['X-Amz-Security-Token', 'T']);
  });
});

describe('Digest', () => {
  it('parses challenges and computes RFC 2617 example response', () => {
    const ch = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')!;
    expect(ch.realm).toBe('testrealm@host.com');
    const header = buildDigestAuthorization(ch, { username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html', nc: 1, cnonce: '0a4f113b' });
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
  });

  it('authenticates against the mock server via challenge/response', async () => {
    const auth = parse({ type: 'digest', username: 'user', password: 'pass' });
    const url = `${srv.url}/digest-auth/user/pass`;
    const first = await sendRequest({ method: 'GET', url, headers: [] });
    expect(first.status).toBe(401);
    const headers = answerChallenge(auth, { method: 'GET', url, headers: [] }, first, ctx());
    expect(headers).toBeDefined();
    const second = await sendRequest({ method: 'GET', url, headers: headers! });
    expect(second.status).toBe(200);
  });
});

describe('OAuth 2.0', () => {
  const cc = (extra: Partial<Auth> = {}) =>
    parse({ type: 'oauth2', grantType: 'client_credentials', tokenUrl: `${srv.url}/oauth/token`, clientId: 'client', clientSecret: 'shh', scope: 'read', ...extra });

  it('client credentials (body and basic auth), caches the token', async () => {
    const store = new MemoryTokenStore();
    const c = ctx({ tokenStore: store });
    const r = await applyAuth(cc(), { method: 'GET', url: `${srv.url}/users`, headers: [] }, c);
    expect(r.headers).toContainEqual(['Authorization', 'Bearer tok-123']);
    const hits = srv.requests.filter((x) => x.url === '/oauth/token').length;
    await applyAuth(cc(), { method: 'GET', url: `${srv.url}/users`, headers: [] }, c);
    expect(srv.requests.filter((x) => x.url === '/oauth/token').length).toBe(hits); // cached
    const basic = await getOAuth2Token(cc({ clientAuthentication: 'basic' } as Partial<Auth>) as never, ctx());
    expect(basic.accessToken).toBe('tok-123');
    const status = await getTokenStatus(cc() as never, c);
    expect(status.hasToken).toBe(true);
    await clearToken(cc() as never, c);
    expect((await getTokenStatus(cc() as never, c)).hasToken).toBe(false);
  });

  it('reports token endpoint errors', async () => {
    await expect(getOAuth2Token(cc({ clientSecret: 'wrong' } as Partial<Auth>) as never, ctx())).rejects.toThrow(/invalid_client/);
  });

  it('refreshes expired tokens automatically', async () => {
    const store = new MemoryTokenStore();
    const config = cc() as never as Parameters<typeof getOAuth2Token>[0];
    await store.set(tokenCacheKey(resolveOAuth2(config, (s) => s)), { accessToken: 'old', tokenType: 'Bearer', refreshToken: 'refresh-1', expiresAt: Date.now() - 1000, obtainedAt: 0 });
    const t = await getOAuth2Token(config, ctx({ tokenStore: store }));
    expect(t.accessToken).toBe('tok-123');
    expect(t.refreshToken).toBe('refresh-2');
  });

  it('password grant', async () => {
    const t = await getOAuth2Token(cc({ grantType: 'password', username: 'demo', password: 'secret' } as Partial<Auth>) as never, ctx());
    expect(t.accessToken).toBe('tok-123');
  });

  it('authorization code + PKCE via loopback redirect', async () => {
    const config = cc({ grantType: 'authorization_code', authUrl: `${srv.url}/oauth/authorize`, redirectUri: 'http://127.0.0.1:0/callback' } as Partial<Auth>) as never;
    const t = await getOAuth2Token(config, {
      resolve: (s) => s,
      interactive: {
        // Simulate the browser: follow the provider redirect back to the loopback listener.
        openBrowser: async (url) => {
          void sendRequest({ method: 'GET', url, headers: [] }, { followRedirects: true }).catch(() => undefined);
        },
      },
    });
    expect(t.accessToken).toBe('tok-123');
    expect(t.refreshToken).toBe('refresh-1');
  });

  it('authorization code fails non-interactively with a hint', async () => {
    const config = cc({ grantType: 'authorization_code', authUrl: `${srv.url}/oauth/authorize` } as Partial<Auth>) as never;
    await expect(getOAuth2Token(config, ctx())).rejects.toThrow(/non-interactively/);
  });

  it('device code grant polls until authorized', async () => {
    const shown: string[] = [];
    const config = cc({ grantType: 'device_code', deviceAuthUrl: `${srv.url}/oauth/device` } as Partial<Auth>) as never;
    const t = await getOAuth2Token(config, { resolve: (s) => s, interactive: { openBrowser: async () => undefined, showDeviceCode: (p) => shown.push(p.userCode) } });
    expect(shown).toEqual(['ABCD-EFGH']);
    expect(t.accessToken).toBe('tok-123');
  });
});

describe('AWS payload hashing with streams', () => {
  it('hashes streamed bodies', async () => {
    const { Readable } = await import('node:stream');
    const r = await applyAuth(
      parse({ type: 'awsv4', accessKeyId: 'A', secretAccessKey: 'B', region: 'us-east-1', service: 's3' }),
      { method: 'PUT', url: 'https://bucket.s3.amazonaws.com/key', headers: [], openBody: () => Readable.from([Buffer.from('hello')]) },
      ctx(),
    );
    expect(r.headers).toContainEqual(['X-Amz-Content-Sha256', '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824']);
  });
});

