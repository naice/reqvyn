import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ReqvynError } from '@reqvyn/shared';
import { sendRequest, bufferBody } from '@reqvyn/http-engine';
import type { OAuth2Config } from '@reqvyn/core';
import type { AuthContext, StoredToken } from './types.js';


/** Seconds before expiry at which a token is considered expired (clock skew / in-flight time). */
const EXPIRY_SKEW_MS = 30_000;
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

export type ResolvedOAuth2 = OAuth2Config;

export function resolveOAuth2(config: OAuth2Config, resolve: (s: string) => string): ResolvedOAuth2 {
  return {
    ...config,
    authUrl: resolve(config.authUrl),
    tokenUrl: resolve(config.tokenUrl),
    deviceAuthUrl: resolve(config.deviceAuthUrl),
    clientId: resolve(config.clientId),
    clientSecret: resolve(config.clientSecret),
    username: resolve(config.username),
    password: resolve(config.password),
    scope: resolve(config.scope),
    audience: resolve(config.audience),
    redirectUri: resolve(config.redirectUri),
    tokenPrefix: resolve(config.tokenPrefix),
    extraParams: config.extraParams.map((p) => ({ ...p, key: resolve(p.key), value: resolve(p.value) })),
  };
}

/** Cache key that identifies a token by its issuing configuration (never includes secrets in clear text). */
export function tokenCacheKey(c: ResolvedOAuth2): string {
  return createHash('sha256')
    .update([c.grantType, c.tokenUrl, c.authUrl, c.clientId, c.scope, c.audience, c.username].join('\n'))
    .digest('hex')
    .slice(0, 32);
}

export function isTokenValid(t: StoredToken | undefined, now = Date.now()): boolean {
  return !!t && !!t.accessToken && (t.expiresAt === undefined || t.expiresAt - EXPIRY_SKEW_MS > now);
}

export interface TokenStatus {
  hasToken: boolean;
  expiresAt?: number;
  scope?: string;
  canRefresh: boolean;
}

export async function getTokenStatus(config: OAuth2Config, ctx: AuthContext): Promise<TokenStatus> {
  const c = resolveOAuth2(config, ctx.resolve);
  const t = await ctx.tokenStore?.get(tokenCacheKey(c));
  return { hasToken: isTokenValid(t, ctx.now?.() ?? Date.now()), expiresAt: t?.expiresAt, scope: t?.scope, canRefresh: !!t?.refreshToken };
}

export async function clearToken(config: OAuth2Config, ctx: AuthContext): Promise<void> {
  const c = resolveOAuth2(config, ctx.resolve);
  await ctx.tokenStore?.delete(tokenCacheKey(c));
}

/**
 * Return a valid access token: cached → refreshed (if allowed) → newly obtained via the configured grant.
 * `interactive: false` prevents opening browsers (e.g. in the CLI).
 */
export async function getOAuth2Token(config: OAuth2Config, ctx: AuthContext, opts: { forceNew?: boolean } = {}): Promise<StoredToken> {
  const c = resolveOAuth2(config, ctx.resolve);
  const key = tokenCacheKey(c);
  const now = ctx.now?.() ?? Date.now();
  const cached = opts.forceNew ? undefined : await ctx.tokenStore?.get(key);
  if (cached && isTokenValid(cached, now)) return cached;
  if (cached?.refreshToken && c.autoRefresh) {
    try {
      ctx.log?.('OAuth 2.0: refreshing access token');
      const refreshed = await refreshToken(c, cached.refreshToken, ctx);
      await ctx.tokenStore?.set(key, refreshed);
      return refreshed;
    } catch (e) {
      ctx.log?.(`OAuth 2.0: refresh failed (${e instanceof Error ? e.message : String(e)}), requesting a new token`);
    }
  }
  const token = await obtainToken(c, ctx);
  await ctx.tokenStore?.set(key, token);
  return token;
}

async function obtainToken(c: ResolvedOAuth2, ctx: AuthContext): Promise<StoredToken> {
  if (!c.tokenUrl) throw new ReqvynError('AUTH', 'OAuth 2.0: token URL is not configured.');
  switch (c.grantType) {
    case 'client_credentials':
      ctx.log?.('OAuth 2.0: client credentials grant');
      return tokenRequest(c, { grant_type: 'client_credentials', ...scopeParams(c) }, ctx);
    case 'password':
      ctx.log?.('OAuth 2.0: password grant');
      return tokenRequest(c, { grant_type: 'password', username: c.username, password: c.password, ...scopeParams(c) }, ctx);
    case 'authorization_code':
      return authorizationCodeFlow(c, ctx);
    case 'device_code':
      return deviceCodeFlow(c, ctx);
  }
}

function scopeParams(c: ResolvedOAuth2): Record<string, string> {
  const out: Record<string, string> = {};
  if (c.scope) out.scope = c.scope;
  if (c.audience) out.audience = c.audience;
  for (const p of c.extraParams) if (p.enabled && p.key) out[p.key] = p.value;
  return out;
}

export async function refreshToken(c: ResolvedOAuth2, refresh: string, ctx: AuthContext): Promise<StoredToken> {
  const t = await tokenRequest(c, { grant_type: 'refresh_token', refresh_token: refresh, ...(c.scope ? { scope: c.scope } : {}) }, ctx);
  // Servers may omit the refresh token on refresh – keep the previous one.
  return { ...t, refreshToken: t.refreshToken ?? refresh };
}

async function tokenRequest(c: ResolvedOAuth2, params: Record<string, string>, ctx: AuthContext): Promise<StoredToken> {
  const form = new URLSearchParams(params);
  const headers: Array<[string, string]> = [['Accept', 'application/json']];
  if (c.clientAuthentication === 'basic' && c.clientId) {
    headers.push(['Authorization', 'Basic ' + Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`).toString('base64')]);
  } else {
    if (c.clientId) form.set('client_id', c.clientId);
    if (c.clientSecret) form.set('client_secret', c.clientSecret);
  }
  const res = await sendRequest(
    { method: 'POST', url: c.tokenUrl, headers, body: bufferBody(form.toString(), 'application/x-www-form-urlencoded') },
    { ...ctx.sendOptions, cookieJar: null, signal: ctx.signal, followRedirects: false },
  );
  const text = Buffer.from(res.body.base64, 'base64').toString('utf8');
  const data = parseTokenResponse(text, res.contentType);
  if (res.status < 200 || res.status >= 300 || !data.access_token) {
    const err = String(data.error ?? `HTTP ${res.status}`);
    const desc = data.error_description ? `: ${String(data.error_description)}` : '';
    throw new ReqvynError('AUTH', `OAuth 2.0 token request failed (${err}${desc}).`, { details: { status: res.status, error: data.error } });
  }
  return toStoredToken(data, ctx.now?.() ?? Date.now());
}

function parseTokenResponse(text: string, contentType: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (/x-www-form-urlencoded|text\/plain/i.test(contentType) || text.includes('=')) return Object.fromEntries(new URLSearchParams(text));
    return {};
  }
}

function toStoredToken(data: Record<string, unknown>, now: number): StoredToken {
  const expiresIn = Number(data.expires_in);
  return {
    accessToken: String(data.access_token),
    tokenType: String(data.token_type ?? 'Bearer'),
    refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
    idToken: data.id_token ? String(data.id_token) : undefined,
    scope: data.scope ? String(data.scope) : undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
    obtainedAt: now,
  };
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Authorization code flow with PKCE using a loopback redirect (RFC 8252). */
async function authorizationCodeFlow(c: ResolvedOAuth2, ctx: AuthContext): Promise<StoredToken> {
  if (!ctx.interactive) {
    throw new ReqvynError('AUTH', 'OAuth 2.0 authorization code flow needs a browser and cannot run non-interactively.', {
      hint: 'Obtain a token in VS Code first, or use client credentials / a pre-issued token in CI.',
    });
  }
  if (!c.authUrl) throw new ReqvynError('AUTH', 'OAuth 2.0: authorization URL is not configured.');
  const redirect = new URL(c.redirectUri || 'http://127.0.0.1:0/callback');
  if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname)) {
    throw new ReqvynError('AUTH', 'OAuth 2.0: the redirect URI must be a loopback address (http://127.0.0.1:<port>/path).', {
      hint: 'Register http://127.0.0.1:<port>/callback with your identity provider.',
    });
  }
  const state = randomBytes(16).toString('base64url');
  const pkce = c.usePkce ? createPkcePair() : undefined;
  const callbackPath = redirect.pathname || '/';

  let resolveCode!: (code: string) => void;
  let rejectCode!: (e: unknown) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== callbackPath) {
      res.writeHead(404).end();
      return;
    }
    const page = (msg: string) =>
      `<!doctype html><meta charset="utf-8"><title>REQVYN</title><body style="font-family:sans-serif;background:#0D111B;color:#F1F5F9;padding:2rem"><h2>REQVYN</h2><p>${msg}</p><p>You can close this window.</p></body>`;
    if (u.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(page('Invalid state parameter.'));
      rejectCode(new ReqvynError('AUTH', 'OAuth 2.0: state mismatch in authorization response (possible CSRF).'));
      return;
    }
    const error = u.searchParams.get('error');
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(page('Authorization failed.'));
      rejectCode(new ReqvynError('AUTH', `OAuth 2.0 authorization failed: ${error}${u.searchParams.get('error_description') ? ` – ${u.searchParams.get('error_description')}` : ''}`));
      return;
    }
    const code = u.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(page('No authorization code received.'));
      rejectCode(new ReqvynError('AUTH', 'OAuth 2.0: no authorization code in redirect.'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Authorization complete.'));
    resolveCode(code);
  });
  const host = redirect.hostname.replace(/^\[|\]$/g, '');
  await new Promise<void>((res, rej) => {
    server.once('error', (e) => rej(new ReqvynError('AUTH', `Cannot listen on redirect URI port ${redirect.port}: ${e.message}`, { cause: e })));
    server.listen(Number(redirect.port || 0), host, () => res());
  });
  const port = (server.address() as AddressInfo).port;
  redirect.port = String(port);
  const redirectUri = redirect.toString();
  const timer = setTimeout(() => rejectCode(new ReqvynError('TIMEOUT', 'OAuth 2.0: timed out waiting for the authorization redirect.')), CALLBACK_TIMEOUT_MS);
  const onAbort = () => rejectCode(new ReqvynError('CANCELLED', 'OAuth 2.0 authorization cancelled.'));
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const authUrl = new URL(c.authUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', c.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    if (c.scope) authUrl.searchParams.set('scope', c.scope);
    if (c.audience) authUrl.searchParams.set('audience', c.audience);
    if (pkce) {
      authUrl.searchParams.set('code_challenge', pkce.challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
    }
    for (const p of c.extraParams) if (p.enabled && p.key) authUrl.searchParams.set(p.key, p.value);
    ctx.log?.(`OAuth 2.0: opening browser for authorization (redirect ${redirectUri})`);
    await ctx.interactive.openBrowser(authUrl.toString());
    const code = await codePromise;
    const params: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: redirectUri };
    if (pkce) params.code_verifier = pkce.verifier;
    return await tokenRequest(c, params, ctx);
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
    server.close();
    server.closeAllConnections?.();
  }
}

/** Device authorization grant (RFC 8628). */
async function deviceCodeFlow(c: ResolvedOAuth2, ctx: AuthContext): Promise<StoredToken> {
  if (!c.deviceAuthUrl) throw new ReqvynError('AUTH', 'OAuth 2.0: device authorization URL is not configured.');
  const form = new URLSearchParams({ client_id: c.clientId, ...scopeParams(c) });
  const res = await sendRequest(
    { method: 'POST', url: c.deviceAuthUrl, headers: [['Accept', 'application/json']], body: bufferBody(form.toString(), 'application/x-www-form-urlencoded') },
    { ...ctx.sendOptions, cookieJar: null, signal: ctx.signal },
  );
  const data = parseTokenResponse(Buffer.from(res.body.base64, 'base64').toString('utf8'), res.contentType);
  if (res.status >= 300 || !data.device_code) throw new ReqvynError('AUTH', `OAuth 2.0 device authorization failed (${String(data.error ?? res.status)}).`);
  const prompt = {
    userCode: String(data.user_code ?? ''),
    verificationUri: String(data.verification_uri ?? data.verification_url ?? ''),
    verificationUriComplete: data.verification_uri_complete ? String(data.verification_uri_complete) : undefined,
    expiresIn: Number(data.expires_in ?? 600),
  };
  if (ctx.interactive?.showDeviceCode) ctx.interactive.showDeviceCode(prompt);
  else ctx.log?.(`OAuth 2.0 device code: open ${prompt.verificationUri} and enter ${prompt.userCode}`);
  let interval = Math.max(0, Number(data.interval ?? 5)) * 1000;
  const deadline = Date.now() + prompt.expiresIn * 1000;
  while (Date.now() < deadline) {
    if (ctx.signal?.aborted) throw new ReqvynError('CANCELLED', 'OAuth 2.0 device authorization cancelled.');
    if (interval) await new Promise((r) => setTimeout(r, interval));
    try {
      return await tokenRequest(c, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: String(data.device_code) }, ctx);
    } catch (e) {
      const code = (e as ReqvynError).details && ((e as ReqvynError).details as { error?: string }).error;
      if (code === 'authorization_pending') continue;
      if (code === 'slow_down') {
        interval += 5000;
        continue;
      }
      throw e;
    }
  }
  throw new ReqvynError('TIMEOUT', 'OAuth 2.0 device code expired before authorization completed.');
}
