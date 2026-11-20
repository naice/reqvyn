import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

/**
 * Local mock API server used by integration tests across packages. Never depends on public APIs.
 */
export const TLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'tls');

export interface MockServer {
  url: string;
  port: number;
  close(): Promise<void>;
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>;
}

const users = new Map<string, { id: string; name: string; email: string }>([
  ['1', { id: '1', name: 'Ada Lovelace', email: 'ada@example.com' }],
  ['2', { id: '2', name: 'Alan Turing', email: 'alan@example.com' }],
]);
let nextUserId = 3;
const VALID_TOKEN = 'tok-123';
const digestNonce = randomBytes(8).toString('hex');

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown, headers: Record<string, string | string[]> = {}): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

export async function handler(req: http.IncomingMessage, res: http.ServerResponse, log: MockServer['requests']): Promise<void> {
  const body = await readBody(req);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  log.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: body.toString('utf8') });
  const auth = req.headers.authorization ?? '';

  if (path === '/echo' || path.startsWith('/echo/')) {
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      /* not json */
    }
    return json(res, 200, {
      method: req.method,
      path,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: body.toString('utf8'),
      json: parsed,
    });
  }
  let m = /^\/status\/(\d{3})$/.exec(path);
  if (m) return json(res, Number(m[1]), { status: Number(m[1]) });
  m = /^\/redirect\/(\d+)$/.exec(path);
  if (m) {
    const n = Number(m[1]);
    res.writeHead(302, { Location: n > 1 ? `/redirect/${n - 1}` : '/echo' });
    return void res.end();
  }
  if (path === '/redirect-307') {
    res.writeHead(307, { Location: '/echo' });
    return void res.end();
  }
  if (path === '/redirect-303') {
    res.writeHead(303, { Location: '/echo' });
    return void res.end();
  }
  if (path === '/redirect-to') {
    res.writeHead(302, { Location: url.searchParams.get('url') ?? '/echo' });
    return void res.end();
  }
  if (path === '/gzip' || path === '/deflate' || path === '/br') {
    const payload = Buffer.from(JSON.stringify({ compressed: path.slice(1), items: Array.from({ length: 50 }, (_, i) => i) }));
    const enc = path.slice(1);
    const data = enc === 'gzip' ? zlib.gzipSync(payload) : enc === 'deflate' ? zlib.deflateSync(payload) : zlib.brotliCompressSync(payload);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': enc, 'Content-Length': data.length });
    return void res.end(data);
  }
  m = /^\/delay\/(\d+)$/.exec(path);
  if (m) {
    const t = setTimeout(() => json(res, 200, { delayed: Number(m![1]) }), Number(m[1]));
    res.on('close', () => clearTimeout(t));
    return;
  }
  m = /^\/large\/(\d+)$/.exec(path);
  if (m) {
    const total = Number(m[1]);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': total });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const write = () => {
      while (sent < total) {
        const n = Math.min(chunk.length, total - sent);
        sent += n;
        if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return void res.once('drain', write);
      }
      res.end();
    };
    return write();
  }
  if (path === '/cookies/set') {
    const cookies = [...url.searchParams].map(([k, v]) => `${k}=${v}; Path=/; HttpOnly`);
    res.writeHead(200, { 'Set-Cookie': cookies, 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ set: Object.fromEntries(url.searchParams) }));
  }
  if (path === '/cookies') return json(res, 200, { cookie: req.headers.cookie ?? '' });
  m = /^\/basic-auth\/([^/]+)\/([^/]+)$/.exec(path);
  if (m) {
    const expected = 'Basic ' + Buffer.from(`${m[1]}:${m[2]}`).toString('base64');
    if (auth === expected) return json(res, 200, { authenticated: true, user: m[1] });
    return json(res, 401, { authenticated: false }, { 'WWW-Authenticate': 'Basic realm="mock"' });
  }
  m = /^\/digest-auth\/([^/]+)\/([^/]+)$/.exec(path);
  if (m) {
    const [user, pass] = [m[1]!, m[2]!];
    const realm = 'mock@reqvyn';
    if (!auth.startsWith('Digest ')) {
      return json(res, 401, { authenticated: false }, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${digestNonce}", opaque="abc", algorithm=MD5` });
    }
    const params = Object.fromEntries(
      [...auth.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((x) => [x[1], x[2] ?? x[3]]),
    ) as Record<string, string>;
    const ha1 = md5(`${user}:${realm}:${pass}`);
    const ha2 = md5(`${req.method}:${params.uri}`);
    const expected = md5(`${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:${params.qop}:${ha2}`);
    if (params.username === user && params.response === expected) return json(res, 200, { authenticated: true, user });
    return json(res, 401, { authenticated: false, reason: 'bad digest' });
  }
  if (path === '/login' && req.method === 'POST') {
    let creds: { username?: string; password?: string } = {};
    try {
      creds = JSON.parse(body.toString('utf8'));
    } catch {
      /* ignore */
    }
    if (creds.username === 'demo' && creds.password === 'secret') return json(res, 200, { accessToken: VALID_TOKEN, expiresIn: 3600 });
    return json(res, 401, { error: 'invalid_credentials' });
  }
  if (path === '/oauth/token' && req.method === 'POST') {
    const form = new URLSearchParams(body.toString('utf8'));
    const basic = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString().split(':') : [];
    const clientId = form.get('client_id') ?? basic[0];
    const clientSecret = form.get('client_secret') ?? basic[1];
    const grant = form.get('grant_type');
    if (clientId !== 'client' || clientSecret !== 'shh') return json(res, 401, { error: 'invalid_client' });
    if (grant === 'client_credentials') return json(res, 200, { access_token: VALID_TOKEN, token_type: 'Bearer', expires_in: 3600, scope: form.get('scope') ?? '' });
    if (grant === 'refresh_token' && form.get('refresh_token') === 'refresh-1') return json(res, 200, { access_token: VALID_TOKEN, token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-2' });
    if (grant === 'authorization_code' && form.get('code') === 'code-1') {
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== lastChallenge) return json(res, 400, { error: 'invalid_grant', reason: 'pkce' });
      return json(res, 200, { access_token: VALID_TOKEN, token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' });
    }
    if (grant === 'password' && form.get('username') === 'demo' && form.get('password') === 'secret') return json(res, 200, { access_token: VALID_TOKEN, token_type: 'Bearer', expires_in: 3600 });
    if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
      deviceTokenPolls++;
      if (deviceTokenPolls < 2) return json(res, 400, { error: 'authorization_pending' });
      return json(res, 200, { access_token: VALID_TOKEN, token_type: 'Bearer', expires_in: 3600 });
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }
  if (path === '/oauth/device' && req.method === 'POST') {
    deviceTokenPolls = 0;
    return json(res, 200, { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri: 'http://localhost/activate', expires_in: 600, interval: 0 });
  }
  if (path === '/oauth/authorize') {
    lastChallenge = url.searchParams.get('code_challenge') ?? '';
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? 'http://127.0.0.1/');
    redirect.searchParams.set('code', 'code-1');
    if (url.searchParams.get('state')) redirect.searchParams.set('state', url.searchParams.get('state')!);
    res.writeHead(302, { Location: redirect.toString() });
    return void res.end();
  }
  if (path.startsWith('/users')) {
    if (auth !== `Bearer ${VALID_TOKEN}`) return json(res, 401, { error: 'unauthorized' });
    m = /^\/users\/(\w+)$/.exec(path);
    if (path === '/users' && req.method === 'GET') return json(res, 200, { items: [...users.values()], total: users.size });
    if (path === '/users' && req.method === 'POST') {
      const data = JSON.parse(body.toString('utf8') || '{}');
      const id = String(nextUserId++);
      const user = { id, name: String(data.name ?? ''), email: String(data.email ?? '') };
      users.set(id, user);
      return json(res, 201, user, { Location: `/users/${id}` });
    }
    if (m && req.method === 'GET') {
      const u = users.get(m[1]!);
      return u ? json(res, 200, u) : json(res, 404, { error: 'not_found' });
    }
    if (m && req.method === 'DELETE') {
      users.delete(m[1]!);
      res.writeHead(204);
      return void res.end();
    }
  }
  if (path === '/xml') {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    return void res.end('<?xml version="1.0"?><root><item id="1">One</item></root>');
  }
  if (path === '/html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return void res.end('<!doctype html><html><body><h1>Hello</h1></body></html>');
  }
  if (path === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    const t = setInterval(() => {
      res.write(`data: event ${i}\n\n`);
      if (++i === 3) {
        clearInterval(t);
        res.end();
      }
    }, 10);
    return;
  }
  if (path === '/schema-user') return json(res, 200, { id: 7, name: 'Grace', tags: ['a', 'b'], active: true });
  json(res, 404, { error: 'not_found', path });
}

let lastChallenge = '';
let deviceTokenPolls = 0;

export async function startMockServer(opts: { https?: boolean; requestClientCert?: boolean } = {}): Promise<MockServer> {
  const requests: MockServer['requests'] = [];
  const listener = (req: http.IncomingMessage, res: http.ServerResponse) => {
    handler(req, res, requests).catch((e) => {
      res.writeHead(500);
      res.end(String(e));
    });
  };
  const server = opts.https
    ? https.createServer(
        {
          key: readFileSync(join(TLS_DIR, 'server.key')),
          cert: readFileSync(join(TLS_DIR, 'server.crt')),
          ca: readFileSync(join(TLS_DIR, 'ca.crt')),
          requestCert: !!opts.requestClientCert,
          rejectUnauthorized: !!opts.requestClientCert,
        },
        listener,
      )
    : http.createServer(listener);
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `${opts.https ? 'https' : 'http'}://${opts.https ? 'localhost' : '127.0.0.1'}:${port}`,
    port,
    requests,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** Minimal forward proxy supporting absolute-URI HTTP requests and CONNECT tunnels. */
export async function startProxyServer(opts: { auth?: string } = {}): Promise<{ url: string; close(): Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    if (opts.auth && req.headers['proxy-authorization'] !== `Basic ${Buffer.from(opts.auth).toString('base64')}`) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic' });
      return void res.end();
    }
    hits.push(`HTTP ${req.url}`);
    const target = new URL(req.url ?? '');
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const upstream = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    req.pipe(upstream);
  });
  server.on('connect', (req, socket: net.Socket, head) => {
    if (opts.auth && req.headers['proxy-authorization'] !== `Basic ${Buffer.from(opts.auth).toString('base64')}`) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    hits.push(`CONNECT ${req.url}`);
    const [host, port] = (req.url ?? '').split(':');
    const up = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** A TCP server that replies with garbage (invalid HTTP). */
export async function startGarbageServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = net.createServer((s) => {
    s.on('data', () => s.end('THIS IS NOT HTTP\r\n\r\n'));
    s.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}
