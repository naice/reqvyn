import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendRequest, bufferBody, multipartBody, CookieJar, buildUrl, shouldBypassProxy, type SendOptions } from '../src/index.js';
import { ReqvynError, isReqvynError } from '@reqvyn/shared';
import { startMockServer, startProxyServer, startGarbageServer, TLS_DIR, type MockServer } from '../../../tests/helpers/mockServer.js';

const text = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');
const ca = readFileSync(join(TLS_DIR, 'ca.crt'));

let srv: MockServer;
let tlsSrv: MockServer;
let mtlsSrv: MockServer;

beforeAll(async () => {
  srv = await startMockServer();
  tlsSrv = await startMockServer({ https: true });
  mtlsSrv = await startMockServer({ https: true, requestClientCert: true });
});
afterAll(async () => {
  await Promise.all([srv.close(), tlsSrv.close(), mtlsSrv.close()]);
});

async function expectError(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(isReqvynError(e)).toBe(true);
    expect((e as { code: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} error`);
}

describe('sendRequest – basics', () => {
  it('sends method, headers and JSON body; returns timings and headers', async () => {
    const res = await sendRequest({
      method: 'POST',
      url: `${srv.url}/echo?x=1`,
      headers: [['X-Test', 'yes'], ['Authorization', 'Bearer secret-token']],
      body: bufferBody(JSON.stringify({ a: 1 }), 'application/json'),
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(text(res.body.base64));
    expect(data.method).toBe('POST');
    expect(data.query).toEqual({ x: '1' });
    expect(data.json).toEqual({ a: 1 });
    expect(data.headers['x-test']).toBe('yes');
    expect(data.headers['content-type']).toBe('application/json');
    expect(data.headers['user-agent']).toMatch(/REQVYN/);
    expect(res.timings.totalMs).toBeGreaterThan(0);
    expect(res.headers.some(([k]) => k.toLowerCase() === 'content-type')).toBe(true);
    // Sensitive headers are redacted in the sent-request snapshot.
    expect(res.sentRequest.headers.find(([k]) => k === 'Authorization')?.[1]).not.toContain('secret-token');
  });

  it('returns non-2xx statuses without throwing', async () => {
    const res = await sendRequest({ method: 'GET', url: `${srv.url}/status/418`, headers: [] });
    expect(res.status).toBe(418);
  });

  it('handles 204 and HEAD without a body', async () => {
    const r1 = await sendRequest({ method: 'DELETE', url: `${srv.url}/users/2`, headers: [['Authorization', 'Bearer tok-123']] });
    expect(r1.status).toBe(204);
    expect(r1.body.size).toBe(0);
    const r2 = await sendRequest({ method: 'HEAD', url: `${srv.url}/echo`, headers: [] });
    expect(r2.body.size).toBe(0);
  });

  it('streams multipart bodies with correct length', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reqvyn-mp-'));
    const file = join(dir, 'hello.txt');
    writeFileSync(file, 'file-content');
    const body = await multipartBody([
      { name: 'field', type: 'text', value: 'value' },
      { name: 'upload', type: 'file', filePath: file },
    ]);
    const res = await sendRequest({ method: 'POST', url: `${srv.url}/echo`, headers: [], body });
    const data = JSON.parse(text(res.body.base64));
    expect(data.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(Number(data.headers['content-length'])).toBe(Buffer.byteLength(data.body));
    expect(data.body).toContain('name="field"');
    expect(data.body).toContain('filename="hello.txt"');
    expect(data.body).toContain('file-content');
  });
});

describe('sendRequest – redirects', () => {
  it('follows redirect chains and records them', async () => {
    const res = await sendRequest({ method: 'GET', url: `${srv.url}/redirect/3`, headers: [] });
    expect(res.status).toBe(200);
    expect(res.redirects).toHaveLength(3);
    expect(res.finalUrl).toBe(`${srv.url}/echo`);
  });

  it('does not follow redirects when disabled', async () => {
    const res = await sendRequest({ method: 'GET', url: `${srv.url}/redirect/1`, headers: [] }, { followRedirects: false });
    expect(res.status).toBe(302);
  });

  it('enforces max redirects', async () => {
    await expectError(sendRequest({ method: 'GET', url: `${srv.url}/redirect/5`, headers: [] }, { maxRedirects: 2 }), 'INVALID_RESPONSE');
  });

  it('keeps method/body on 307 and switches to GET on 303', async () => {
    const r307 = await sendRequest({ method: 'POST', url: `${srv.url}/redirect-307`, headers: [], body: bufferBody('payload', 'text/plain') });
    expect(JSON.parse(text(r307.body.base64))).toMatchObject({ method: 'POST', body: 'payload' });
    const r303 = await sendRequest({ method: 'POST', url: `${srv.url}/redirect-303`, headers: [], body: bufferBody('payload', 'text/plain') });
    expect(JSON.parse(text(r303.body.base64))).toMatchObject({ method: 'GET', body: '' });
  });

  it('checks every hop with allowUrl (initial request and redirects)', async () => {
    const seen: string[] = [];
    const allowUrl = (u: string) => {
      seen.push(u);
      if (new URL(u).hostname === 'localhost') throw new ReqvynError('UNTRUSTED', 'blocked');
    };
    const target = srv.url.replace('127.0.0.1', 'localhost') + '/echo';
    await expectError(sendRequest({ method: 'GET', url: `${srv.url}/redirect-to?url=${encodeURIComponent(target)}`, headers: [] }, { allowUrl }), 'UNTRUSTED');
    expect(seen).toEqual([`${srv.url}/redirect-to?url=${encodeURIComponent(target)}`, target]);
  });

  it('strips Authorization on cross-origin redirects', async () => {
    const other = await startMockServer();
    try {
      // 127.0.0.1 vs localhost are different origins
      const target = other.url.replace('127.0.0.1', 'localhost') + '/echo';
      const res = await sendRequest({
        method: 'GET',
        url: `${srv.url}/redirect-to?url=${encodeURIComponent(target)}`,
        headers: [['Authorization', 'Bearer abc']],
      });
      const data = JSON.parse(text(res.body.base64));
      expect(data.headers.authorization).toBeUndefined();
    } finally {
      await other.close();
    }
  });
});

describe('sendRequest – decoding and limits', () => {
  for (const enc of ['gzip', 'deflate', 'br']) {
    it(`decompresses ${enc}`, async () => {
      const res = await sendRequest({ method: 'GET', url: `${srv.url}/${enc}`, headers: [] });
      expect(JSON.parse(text(res.body.base64)).compressed).toBe(enc);
    });
  }

  it('keeps raw bytes when decompression is disabled', async () => {
    const res = await sendRequest({ method: 'GET', url: `${srv.url}/gzip`, headers: [] }, { decompress: false });
    const buf = Buffer.from(res.body.base64, 'base64');
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
  });

  it('truncates bodies above maxBodyBytes but reports the full size', async () => {
    const res = await sendRequest({ method: 'GET', url: `${srv.url}/large/300000`, headers: [] }, { maxBodyBytes: 1000 });
    expect(res.body.truncated).toBe(true);
    expect(res.body.size).toBe(300000);
    expect(Buffer.from(res.body.base64, 'base64').length).toBe(1000);
  });

  it('downloads large bodies to a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reqvyn-dl-'));
    const target = join(dir, 'out.bin');
    const res = await sendRequest({ method: 'GET', url: `${srv.url}/large/2000000`, headers: [] }, { maxBodyBytes: 10, downloadPath: target });
    expect(res.body.savedTo).toBe(target);
    expect(statSync(target).size).toBe(2000000);
  });

  it('reports streaming chunks', async () => {
    const chunks: string[] = [];
    const res = await sendRequest({ method: 'GET', url: `${srv.url}/stream`, headers: [] }, { onChunk: (c) => chunks.push(c.toString()) });
    expect(res.status).toBe(200);
    expect(chunks.join('')).toContain('data: event 2');
  });
});

describe('sendRequest – cookies', () => {
  it('stores Set-Cookie in the jar and sends it on subsequent requests', async () => {
    const jar = new CookieJar();
    const opts: SendOptions = { cookieJar: jar };
    const r1 = await sendRequest({ method: 'GET', url: `${srv.url}/cookies/set?session=abc&theme=dark`, headers: [] }, opts);
    expect(r1.cookies.map((c) => c.name).sort()).toEqual(['session', 'theme']);
    const r2 = await sendRequest({ method: 'GET', url: `${srv.url}/cookies`, headers: [] }, opts);
    const cookie = JSON.parse(text(r2.body.base64)).cookie as string;
    expect(cookie).toContain('session=abc');
    expect(cookie).toContain('theme=dark');
  });
});

describe('sendRequest – errors', () => {
  it('times out', async () => {
    await expectError(sendRequest({ method: 'GET', url: `${srv.url}/delay/2000`, headers: [] }, { timeoutMs: 100 }), 'TIMEOUT');
  });

  it('can be cancelled', async () => {
    const ac = new AbortController();
    const p = sendRequest({ method: 'GET', url: `${srv.url}/delay/2000`, headers: [] }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expectError(p, 'CANCELLED');
  });

  it('maps connection refused', async () => {
    const tmp = await startMockServer();
    const url = tmp.url;
    await tmp.close();
    await expectError(sendRequest({ method: 'GET', url: `${url}/echo`, headers: [] }, { timeoutMs: 5000 }), 'CONNECTION');
  });

  it('maps DNS failures', async () => {
    await expectError(sendRequest({ method: 'GET', url: 'http://does-not-exist.invalid/', headers: [] }, { timeoutMs: 10000 }), 'DNS');
  });

  it('maps invalid HTTP responses', async () => {
    const g = await startGarbageServer();
    try {
      await expectError(sendRequest({ method: 'GET', url: g.url, headers: [] }, { timeoutMs: 5000 }), 'INVALID_RESPONSE');
    } finally {
      await g.close();
    }
  });
});

describe('sendRequest – TLS', () => {
  it('rejects self-signed certificates by default', async () => {
    await expectError(sendRequest({ method: 'GET', url: `${tlsSrv.url}/echo`, headers: [] }), 'TLS');
  });

  it('accepts the server with a custom CA', async () => {
    const res = await sendRequest({ method: 'GET', url: `${tlsSrv.url}/echo`, headers: [] }, { tls: { ca: [ca] } });
    expect(res.status).toBe(200);
    expect(res.timeline.some((e) => e.type === 'tls')).toBe(true);
  });

  it('allows explicitly disabling verification and logs a warning', async () => {
    const res = await sendRequest({ method: 'GET', url: `${tlsSrv.url}/echo`, headers: [] }, { tls: { verify: false } });
    expect(res.status).toBe(200);
    expect(res.timeline.some((e) => /DISABLED/.test(e.message))).toBe(true);
  });

  it('supports client certificates (mTLS)', async () => {
    await expect(sendRequest({ method: 'GET', url: `${mtlsSrv.url}/echo`, headers: [] }, { tls: { ca: [ca] } })).rejects.toBeTruthy();
    const res = await sendRequest(
      { method: 'GET', url: `${mtlsSrv.url}/echo`, headers: [] },
      { tls: { ca: [ca], cert: readFileSync(join(TLS_DIR, 'client.crt')), key: readFileSync(join(TLS_DIR, 'client.key')) } },
    );
    expect(res.status).toBe(200);
  });
});

describe('sendRequest – proxy', () => {
  it('sends plain HTTP through a forward proxy', async () => {
    const proxy = await startProxyServer();
    try {
      const target = srv.url.replace('127.0.0.1', 'localhost');
      const res = await sendRequest({ method: 'GET', url: `${target}/echo?via=proxy`, headers: [] }, { proxy: { url: proxy.url } });
      expect(res.status).toBe(200);
      expect(proxy.hits.some((h) => h.startsWith('HTTP '))).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it('tunnels HTTPS through CONNECT with proxy auth', async () => {
    const proxy = await startProxyServer({ auth: 'user:pw' });
    try {
      const proxyUrl = proxy.url.replace('http://', 'http://user:pw@');
      const res = await sendRequest({ method: 'GET', url: `${tlsSrv.url}/echo`, headers: [] }, { proxy: { url: proxyUrl }, tls: { ca: [ca] } });
      expect(res.status).toBe(200);
      expect(proxy.hits.some((h) => h.startsWith('CONNECT '))).toBe(true);
      await expectError(sendRequest({ method: 'GET', url: `${tlsSrv.url}/echo`, headers: [] }, { proxy: { url: proxy.url }, tls: { ca: [ca] } }), 'PROXY');
    } finally {
      await proxy.close();
    }
  });

  it('honours no-proxy rules', async () => {
    expect(shouldBypassProxy('api.internal.corp', ['.internal.corp'])).toBe(true);
    expect(shouldBypassProxy('internal.corp', ['*.internal.corp'])).toBe(true);
    expect(shouldBypassProxy('example.com', ['internal.corp'])).toBe(false);
    expect(shouldBypassProxy('anything', ['*'])).toBe(true);
  });
});

describe('buildUrl', () => {
  it('appends enabled params and adds a scheme', () => {
    expect(buildUrl('example.com/api', [{ key: 'a', value: '1 2', enabled: true }, { key: 'b', value: 'x', enabled: false }])).toBe('http://example.com/api?a=1%202');
  });
  it('does not duplicate params already in the URL', () => {
    expect(buildUrl('http://x.test/?a=1', [{ key: 'a', value: '1', enabled: true }])).toBe('http://x.test/?a=1');
  });
  it('rejects unsupported schemes', () => {
    expect(() => buildUrl('file:///etc/passwd')).toThrow();
  });
});
