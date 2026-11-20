import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { createWriteStream } from 'node:fs';
import type { Socket } from 'node:net';
import type { Readable, Transform } from 'node:stream';
import { ReqvynError, isSensitiveHeader, REDACTED } from '@reqvyn/shared';
import type { Cookie, HttpResponseData, TimelineEvent, Timings } from '@reqvyn/core';
import type { PreparedBody } from './body.js';
import { CookieJar } from './cookies.js';
import { mapNetworkError } from './errors.js';

export interface OutgoingRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: PreparedBody;
}

export interface ProxyConfig {
  /** e.g. http://user:pass@proxy.local:3128 */
  url: string;
  /** Hosts that bypass the proxy. Supports exact hosts, `.suffix`/`*.suffix` and `*`. */
  noProxy?: string[];
}

export interface TlsOptions {
  /** Verify server certificates. Defaults to true; REQVYN never disables verification implicitly. */
  verify?: boolean;
  ca?: Array<string | Buffer>;
  cert?: string | Buffer;
  key?: string | Buffer;
  pfx?: Buffer;
  passphrase?: string;
}

export interface SendOptions {
  timeoutMs?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  decompress?: boolean;
  /** Maximum number of body bytes kept in memory. Further bytes are counted (and written to `downloadPath` if set) but not buffered. */
  maxBodyBytes?: number;
  /** Stream the whole response body to this file. */
  downloadPath?: string;
  proxy?: ProxyConfig | null;
  tls?: TlsOptions;
  cookieJar?: CookieJar | null;
  signal?: AbortSignal;
  /** Called for every decoded body chunk (streaming responses). */
  onChunk?: (chunk: Buffer) => void;
  userAgent?: string;
  /**
   * Called with the URL of every hop (initial request and each redirect) before connecting.
   * Throw to block the request – used to enforce host allow-lists (e.g. the MCP trust policy).
   */
  allowUrl?: (url: string) => void;
}

/** Transport abstraction so the engine can be replaced (e.g. by a mock in tests or another HTTP stack). */
export interface HttpTransport {
  send(request: OutgoingRequest, options?: SendOptions): Promise<HttpResponseData>;
}

export const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class NodeHttpTransport implements HttpTransport {
  async send(request: OutgoingRequest, options: SendOptions = {}): Promise<HttpResponseData> {
    return sendRequest(request, options);
  }
}

export function shouldBypassProxy(host: string, noProxy: string[] = []): boolean {
  const h = host.toLowerCase();
  return noProxy.some((raw) => {
    const p = raw.trim().toLowerCase();
    if (!p) return false;
    if (p === '*') return true;
    const bare = p.replace(/^\*?\./, '').replace(/:\d+$/, '');
    return h === bare || h.endsWith('.' + bare);
  });
}

/** Execute an HTTP request with redirects, cookies, decompression, proxy, TLS options, limits and timings. */
export async function sendRequest(request: OutgoingRequest, options: SendOptions = {}): Promise<HttpResponseData> {
  const startedAt = Date.now();
  const t0 = performance.now();
  const timeline: TimelineEvent[] = [];
  const log = (type: TimelineEvent['type'], message: string) => timeline.push({ at: Date.now(), type, message });

  const controller = new AbortController();
  let abortReason: ReqvynError | undefined;
  const abort = (reason: ReqvynError) => {
    if (!abortReason) {
      abortReason = reason;
      controller.abort();
    }
  };
  const onUserAbort = () => abort(new ReqvynError('CANCELLED', 'Request cancelled'));
  if (options.signal?.aborted) throw new ReqvynError('CANCELLED', 'Request cancelled');
  options.signal?.addEventListener('abort', onUserAbort, { once: true });
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timer =
    timeoutMs > 0
      ? setTimeout(
          () => abort(new ReqvynError('TIMEOUT', `Request timed out after ${timeoutMs} ms`, { hint: 'Increase the timeout in the request settings.' })),
          timeoutMs,
        )
      : undefined;

  const redirects: Array<{ url: string; status: number }> = [];
  let method = request.method.toUpperCase();
  let url = request.url;
  let headers = [...request.headers];
  let body = request.body;
  const maxRedirects = options.maxRedirects ?? 10;
  const jar = options.cookieJar ?? null;

  try {
    for (let hop = 0; ; hop++) {
      options.allowUrl?.(url);
      const outHeaders = prepareHeaders(headers, body, url, jar, options);
      log('request', `${method} ${url}`);
      const { res, timings, remoteAddress, viaProxy } = await performHop(method, url, outHeaders, body, options, controller.signal, () => abortReason, log);
      if (viaProxy) log('info', `Via proxy ${viaProxy}`);
      const setCookies = res.headers['set-cookie'] ?? [];
      if (jar) for (const sc of setCookies) jar.setCookie(sc, url);

      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (options.followRedirects !== false && REDIRECT_STATUSES.has(status) && location) {
        res.resume();
        if (redirects.length >= maxRedirects) {
          throw new ReqvynError('INVALID_RESPONSE', `Too many redirects (more than ${maxRedirects}).`, { hint: 'Increase "max redirects" or disable redirect following.' });
        }
        const next = new URL(location, url).toString();
        redirects.push({ url, status });
        log('redirect', `${status} → ${next}`);
        const sameOrigin = new URL(next).origin === new URL(url).origin;
        if (status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = method === 'HEAD' ? 'HEAD' : 'GET';
          body = undefined;
          headers = headers.filter(([k]) => !/^(content-type|content-length|transfer-encoding)$/i.test(k));
        }
        if (!sameOrigin) {
          headers = headers.filter(([k]) => !/^(authorization|cookie|proxy-authorization)$/i.test(k));
          log('info', 'Cross-origin redirect: Authorization and Cookie headers were removed.');
        }
        url = next;
        continue;
      }

      const firstByteMs = performance.now() - t0;
      const bodyResult = await readBody(res, method, options, () => abortReason, controller.signal);
      const totalMs = performance.now() - t0;
      log('response', `${status} ${res.statusMessage ?? ''} (${bodyResult.size} bytes)`);

      const headerPairs: Array<[string, string]> = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) headerPairs.push([res.rawHeaders[i] as string, res.rawHeaders[i + 1] as string]);
      const headersSize = res.rawHeaders.reduce((n, s) => n + s.length + 2, 0) + 2;
      const cookies: Cookie[] = setCookies.map((sc) => parseResponseCookie(sc));
      const finalTimings: Timings = {
        ...timings,
        startedAt,
        firstByteMs: timings.firstByteMs ?? firstByteMs,
        downloadMs: Math.max(0, totalMs - (timings.firstByteMs ?? firstByteMs)),
        totalMs,
      };
      return {
        status,
        statusText: res.statusMessage ?? '',
        httpVersion: res.httpVersion,
        headers: headerPairs,
        contentType: String(res.headers['content-type'] ?? ''),
        body: {
          base64: bodyResult.buffer.toString('base64'),
          size: bodyResult.size,
          truncated: bodyResult.truncated,
          savedTo: bodyResult.savedTo,
        },
        timings: finalTimings,
        redirects,
        cookies,
        headersSize,
        finalUrl: url,
        remoteAddress,
        timeline,
        sentRequest: {
          method,
          url,
          headers: outHeaders.map(([k, v]) => [k, isSensitiveHeader(k) ? REDACTED : v]),
          bodyPreview: body?.preview,
        },
      };
    }
  } catch (e) {
    if (abortReason) throw abortReason;
    throw mapNetworkError(e, { url, viaProxy: options.proxy?.url ? redactUrl(options.proxy.url) : undefined });
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onUserAbort);
  }
}

function prepareHeaders(
  headers: Array<[string, string]>,
  body: PreparedBody | undefined,
  url: string,
  jar: CookieJar | null,
  options: SendOptions,
): Array<[string, string]> {
  const out = headers.filter(([k]) => k.trim() !== '');
  const has = (name: string) => out.some(([k]) => k.toLowerCase() === name);
  if (body) {
    if (!has('content-type') && body.contentType) out.push(['Content-Type', body.contentType]);
    if (!has('content-length') && body.length !== undefined && !has('transfer-encoding')) out.push(['Content-Length', String(body.length)]);
  }
  if (!has('user-agent')) out.push(['User-Agent', options.userAgent ?? 'REQVYN/0.1']);
  if (!has('accept')) out.push(['Accept', '*/*']);
  if (options.decompress !== false && !has('accept-encoding')) out.push(['Accept-Encoding', 'gzip, deflate, br']);
  if (jar) {
    const jarCookies = jar.getCookieHeader(url);
    if (jarCookies) {
      const idx = out.findIndex(([k]) => k.toLowerCase() === 'cookie');
      if (idx >= 0) out[idx] = [out[idx]![0], `${out[idx]![1]}; ${jarCookies}`];
      else out.push(['Cookie', jarCookies]);
    }
  }
  return out;
}

function toNodeHeaders(pairs: Array<[string, string]>): http.OutgoingHttpHeaders {
  const out: Record<string, string | string[]> = {};
  const canonical = new Map<string, string>();
  for (const [k, v] of pairs) {
    const lower = k.toLowerCase();
    const key = canonical.get(lower) ?? k;
    canonical.set(lower, key);
    const existing = out[key];
    if (existing === undefined) out[key] = v;
    else if (lower === 'cookie') out[key] = `${existing}; ${v}`;
    else out[key] = Array.isArray(existing) ? [...existing, v] : [existing, v];
  }
  return out;
}

interface HopResult {
  res: http.IncomingMessage;
  timings: Omit<Timings, 'startedAt' | 'totalMs'>;
  remoteAddress?: string;
  viaProxy?: string;
}

async function performHop(
  method: string,
  url: string,
  headers: Array<[string, string]>,
  body: PreparedBody | undefined,
  options: SendOptions,
  signal: AbortSignal,
  getAbortReason: () => ReqvynError | undefined,
  log: (type: TimelineEvent['type'], message: string) => void,
): Promise<HopResult> {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const port = Number(target.port || (isHttps ? 443 : 80));
  const tlsOpts = options.tls ?? {};
  const verify = tlsOpts.verify !== false;
  if (isHttps && !verify) log('tls', 'TLS certificate verification is DISABLED for this request.');
  const useProxy = options.proxy?.url && !shouldBypassProxy(target.hostname, options.proxy.noProxy) ? options.proxy : null;
  const start = performance.now();
  const timings: HopResult['timings'] = {};
  const nodeHeaders = toNodeHeaders(headers);

  const tlsConnectOptions: tls.ConnectionOptions = {
    servername: isIp(target.hostname) ? undefined : target.hostname,
    rejectUnauthorized: verify,
    ca: tlsOpts.ca && tlsOpts.ca.length ? [...tls.rootCertificates, ...tlsOpts.ca.map(String)] : undefined,
    cert: tlsOpts.cert,
    key: tlsOpts.key,
    pfx: tlsOpts.pfx,
    passphrase: tlsOpts.passphrase,
    ALPNProtocols: ['http/1.1'],
  };

  let requestOptions: https.RequestOptions;
  let viaProxy: string | undefined;
  if (useProxy) {
    const proxyUrl = new URL(useProxy.url);
    viaProxy = redactUrl(useProxy.url);
    const proxyAuth = proxyUrl.username
      ? 'Basic ' + Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')
      : undefined;
    if (isHttps) {
      const tunnel = await connectTunnel(proxyUrl, target.hostname, port, proxyAuth, signal);
      timings.connectMs = performance.now() - start;
      log('connect', `Tunnel established through proxy to ${target.hostname}:${port}`);
      const secure = tls.connect({ ...tlsConnectOptions, socket: tunnel });
      secure.once('secureConnect', () => {
        timings.tlsMs = performance.now() - start - (timings.connectMs ?? 0);
        log('tls', describeTls(secure));
      });
      requestOptions = {
        method,
        host: target.hostname,
        port,
        path: target.pathname + target.search,
        headers: nodeHeaders,
        agent: tunnelAgent(secure),
      };
    } else {
      const proxyHeaders = { ...nodeHeaders } as Record<string, string | string[]>;
      if (proxyAuth) proxyHeaders['Proxy-Authorization'] = proxyAuth;
      requestOptions = {
        method,
        host: proxyUrl.hostname,
        port: Number(proxyUrl.port || 80),
        path: target.toString(),
        headers: { Host: target.host, ...proxyHeaders },
        agent: false,
      };
    }
  } else {
    requestOptions = {
      method,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port,
      path: target.pathname + target.search,
      headers: nodeHeaders,
      agent: false,
      ...(isHttps ? tlsConnectOptions : {}),
    };
    if (target.username) requestOptions.auth = `${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`;
  }

  // For tunnelled HTTPS, createConnection supplies the already-established TLS socket.
  const requester = isHttps ? https : http;

  return new Promise<HopResult>((resolve, reject) => {
    let settled = false;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      reject(getAbortReason() ?? e);
    };
    const req = requester.request(requestOptions, (res) => {
      timings.firstByteMs = performance.now() - start;
      settled = true;
      resolve({ res, timings, remoteAddress: req.socket?.remoteAddress ?? undefined, viaProxy });
    });
    const onAbort = () => req.destroy(getAbortReason() ?? new ReqvynError('CANCELLED', 'Request cancelled'));
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal.removeEventListener('abort', onAbort));
    req.on('socket', (socket: Socket) => {
      socket.once('lookup', (_err, address) => {
        timings.dnsMs = performance.now() - start;
        log('dns', `Resolved ${target.hostname} → ${address}`);
      });
      socket.once('connect', () => {
        timings.connectMs = performance.now() - start - (timings.dnsMs ?? 0);
        log('connect', `Connected to ${socket.remoteAddress}:${socket.remotePort}`);
      });
      if (isHttps && !useProxy) {
        socket.once('secureConnect', () => {
          timings.tlsMs = performance.now() - start - (timings.dnsMs ?? 0) - (timings.connectMs ?? 0);
          log('tls', describeTls(socket as tls.TLSSocket));
        });
      }
    });
    req.on('error', fail);
    if (body && method !== 'GET' && method !== 'HEAD') {
      const stream = body.open();
      stream.on('error', (e) => {
        req.destroy(e);
        fail(new ReqvynError('IO', `Failed to read request body: ${e.message}`, { cause: e }));
      });
      stream.pipe(req);
    } else if (body && (method === 'GET' || method === 'HEAD') && body.length) {
      // Some APIs (e.g. Elasticsearch) accept GET bodies; send it when explicitly configured.
      body.open().pipe(req);
    } else {
      req.end();
    }
  });
}

/** An https.Agent that hands out the pre-established TLS socket (https.request ignores `createConnection` when an agent is used). */
function tunnelAgent(secure: tls.TLSSocket): https.Agent {
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
  (agent as unknown as { createConnection: () => tls.TLSSocket }).createConnection = () => secure;
  return agent;
}

function connectTunnel(proxyUrl: URL, host: string, port: number, proxyAuth: string | undefined, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `${host}:${port}` };
    if (proxyAuth) headers['Proxy-Authorization'] = proxyAuth;
    const req = http.request({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port || 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      agent: false,
    });
    const onAbort = () => req.destroy(new ReqvynError('CANCELLED', 'Request cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    req.once('connect', (res, socket) => {
      signal.removeEventListener('abort', onAbort);
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(
          new ReqvynError('PROXY', `Proxy refused tunnel to ${host}:${port} (HTTP ${res.statusCode}).`, {
            hint: res.statusCode === 407 ? 'The proxy requires authentication. Add credentials to the proxy URL.' : 'Check proxy configuration.',
          }),
        );
        return;
      }
      resolve(socket);
    });
    req.once('error', (e) => {
      signal.removeEventListener('abort', onAbort);
      reject(new ReqvynError('PROXY', `Cannot connect to proxy ${proxyUrl.host}: ${e.message}`, { cause: e, hint: 'Check the proxy URL.' }));
    });
    req.end();
  });
}

interface BodyReadResult {
  buffer: Buffer;
  size: number;
  truncated: boolean;
  savedTo?: string;
}

async function readBody(
  res: http.IncomingMessage,
  method: string,
  options: SendOptions,
  getAbortReason: () => ReqvynError | undefined,
  signal: AbortSignal,
): Promise<BodyReadResult> {
  if (method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304) {
    res.resume();
    return { buffer: Buffer.alloc(0), size: 0, truncated: false };
  }
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  let stream: Readable = res;
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
  if (options.decompress !== false && encoding) {
    const decoder = await createDecoder(encoding, res);
    if (decoder) stream = res.pipe(decoder);
  }
  const file = options.downloadPath ? createWriteStream(options.downloadPath) : undefined;
  const chunks: Buffer[] = [];
  let kept = 0;
  let size = 0;
  let truncated = false;
  const onAbort = () => {
    res.destroy();
    stream.destroy(getAbortReason());
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const raw of stream) {
      const chunk = raw as Buffer;
      size += chunk.length;
      options.onChunk?.(chunk);
      if (file && !file.write(chunk)) await new Promise<void>((r) => file.once('drain', () => r()));
      if (kept < limit) {
        const take = Math.min(chunk.length, limit - kept);
        chunks.push(take === chunk.length ? chunk : chunk.subarray(0, take));
        kept += take;
        if (take < chunk.length) truncated = true;
      } else {
        truncated = true;
      }
    }
  } catch (e) {
    file?.destroy();
    throw getAbortReason() ?? e;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (getAbortReason()) throw getAbortReason();
  if (file) await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())));
  return { buffer: Buffer.concat(chunks, kept), size, truncated, savedTo: options.downloadPath };
}

async function createDecoder(encoding: string, res: http.IncomingMessage): Promise<Transform | undefined> {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
    case 'br':
      return zlib.createBrotliDecompress();
    case 'deflate': {
      // Some servers send raw deflate without zlib header; sniff the first byte.
      const first = await peekFirstByte(res);
      return first !== undefined && (first & 0x0f) === 0x08 ? zlib.createInflate() : zlib.createInflateRaw();
    }
    default:
      return undefined;
  }
}

function peekFirstByte(res: http.IncomingMessage): Promise<number | undefined> {
  return new Promise((resolve) => {
    const onReadable = () => {
      const chunk = res.read(1) as Buffer | null;
      res.off('readable', onReadable);
      res.off('end', onEnd);
      if (chunk) {
        res.unshift(chunk);
        resolve(chunk[0]);
      } else resolve(undefined);
    };
    const onEnd = () => {
      res.off('readable', onReadable);
      resolve(undefined);
    };
    res.on('readable', onReadable);
    res.once('end', onEnd);
  });
}

function parseResponseCookie(header: string): Cookie {
  const [first, ...attrs] = header.split(';');
  const eq = (first ?? '').indexOf('=');
  const cookie: Cookie = { name: (first ?? '').slice(0, eq).trim(), value: (first ?? '').slice(eq + 1).trim() };
  for (const a of attrs) {
    const i = a.indexOf('=');
    const k = (i === -1 ? a : a.slice(0, i)).trim().toLowerCase();
    const v = i === -1 ? '' : a.slice(i + 1).trim();
    if (k === 'domain') cookie.domain = v;
    else if (k === 'path') cookie.path = v;
    else if (k === 'expires') cookie.expires = v;
    else if (k === 'max-age') cookie.maxAge = Number(v);
    else if (k === 'secure') cookie.secure = true;
    else if (k === 'httponly') cookie.httpOnly = true;
    else if (k === 'samesite') cookie.sameSite = v;
  }
  return cookie;
}

function describeTls(socket: tls.TLSSocket): string {
  try {
    const cert = socket.getPeerCertificate();
    const proto = socket.getProtocol();
    const cipher = socket.getCipher()?.name;
    const subject = cert?.subject?.CN ?? '';
    const issuer = cert?.issuer?.CN ?? cert?.issuer?.O ?? '';
    return `TLS ${proto ?? ''} ${cipher ?? ''}${subject ? `, certificate CN=${subject}` : ''}${issuer ? `, issuer ${issuer}` : ''}${cert?.valid_to ? `, valid until ${cert.valid_to}` : ''}${socket.authorized ? '' : `, NOT verified (${String(socket.authorizationError ?? 'unknown')})`}`;
  } catch {
    return 'TLS handshake complete';
  }
}

function isIp(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
}

export function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return u;
  }
}
