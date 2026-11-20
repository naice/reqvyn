import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { ReqvynError } from '@reqvyn/shared';
import type { AuthContext, AuthRequest, AuthResult, ConcreteAuth } from './types.js';
import { signJwt } from './jwt.js';
import { signAwsV4, sha256Payload } from './awsv4.js';
import { getOAuth2Token } from './oauth2.js';
import { parseDigestChallenge, buildDigestAuthorization } from './digest.js';

function setHeader(headers: Array<[string, string]>, name: string, value: string): Array<[string, string]> {
  const out = headers.filter(([k]) => k.toLowerCase() !== name.toLowerCase());
  out.push([name, value]);
  return out;
}

function hasHeader(headers: Array<[string, string]>, name: string): boolean {
  return headers.some(([k]) => k.toLowerCase() === name.toLowerCase());
}

function addQuery(url: string, key: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

async function hashStream(open: () => NodeJS.ReadableStream): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of open() as AsyncIterable<Buffer | string>) h.update(chunk);
  return h.digest('hex');
}

/**
 * Apply authentication to an outgoing request. Explicit Authorization headers set by the user win
 * over header-based auth (the user's intent is explicit).
 */
export async function applyAuth(auth: ConcreteAuth, req: AuthRequest, ctx: AuthContext): Promise<AuthResult> {
  const r = ctx.resolve;
  let headers = [...req.headers];
  let url = req.url;
  const userAuthHeader = hasHeader(headers, 'authorization');
  const putAuthorization = (value: string) => {
    if (userAuthHeader) {
      ctx.log?.('Auth: an explicit Authorization header is set on the request and takes precedence.');
      return;
    }
    headers = setHeader(headers, 'Authorization', value);
  };

  switch (auth.type) {
    case 'none':
      return { url, headers, description: 'No authentication' };
    case 'basic': {
      const user = r(auth.username);
      putAuthorization('Basic ' + Buffer.from(`${user}:${r(auth.password)}`).toString('base64'));
      return { url, headers, description: `Basic auth as "${user}"` };
    }
    case 'bearer': {
      const token = r(auth.token);
      if (!token) ctx.log?.('Auth: bearer token is empty.');
      const prefix = r(auth.prefix ?? 'Bearer');
      putAuthorization(prefix ? `${prefix} ${token}` : token);
      return { url, headers, description: 'Bearer token' };
    }
    case 'apikey': {
      const key = r(auth.key);
      if (!key) throw new ReqvynError('AUTH', 'API key name is empty.');
      const value = r(auth.value);
      if (auth.in === 'query') url = addQuery(url, key, value);
      else headers = setHeader(headers, key, value);
      return { url, headers, description: `API key in ${auth.in} "${key}"` };
    }
    case 'jwt': {
      const token = signJwt({
        algorithm: auth.algorithm,
        secret: r(auth.secret),
        secretBase64: auth.secretBase64,
        payload: r(auth.payload),
        header: r(auth.header),
        expiresInSeconds: auth.expiresInSeconds,
        now: ctx.now?.(),
      });
      if (auth.addTo === 'query') url = addQuery(url, r(auth.queryParam) || 'token', token);
      else putAuthorization(auth.headerPrefix ? `${r(auth.headerPrefix)} ${token}` : token);
      return { url, headers, description: `JWT (${auth.algorithm})` };
    }
    case 'oauth2': {
      const token = await getOAuth2Token(auth, ctx);
      const prefix = r(auth.tokenPrefix ?? 'Bearer');
      putAuthorization(prefix ? `${prefix} ${token.accessToken}` : token.accessToken);
      return { url, headers, description: `OAuth 2.0 (${auth.grantType})` };
    }
    case 'awsv4': {
      const accessKeyId = r(auth.accessKeyId);
      const secretAccessKey = r(auth.secretAccessKey);
      if (!accessKeyId || !secretAccessKey) throw new ReqvynError('AUTH', 'AWS Signature v4 requires an access key ID and secret access key.');
      const payloadHash = req.bodyBytes ? sha256Payload(req.bodyBytes) : req.openBody ? await hashStream(req.openBody) : sha256Payload('');
      const added = signAwsV4(
        { method: req.method, url, headers, payloadHash },
        { accessKeyId, secretAccessKey, sessionToken: r(auth.sessionToken) || undefined, region: r(auth.region), service: r(auth.service) },
        ctx.now ? new Date(ctx.now()) : new Date(),
      );
      for (const [k, v] of added) headers = setHeader(headers, k, v);
      return { url, headers, description: `AWS SigV4 (${r(auth.service)}/${r(auth.region)})` };
    }
    case 'digest':
      // Digest needs the server challenge; the first request is sent without credentials and
      // `answerChallenge` computes the header from the 401 response.
      return { url, headers, description: 'Digest auth (awaiting challenge)' };
    case 'clientcert': {
      const load = async (p: string) => {
        const path = r(p);
        if (!path) return undefined;
        const full = isAbsolute(path) || !ctx.baseDir ? path : resolvePath(ctx.baseDir, path);
        try {
          return await readFile(full);
        } catch (e) {
          throw new ReqvynError('AUTH', `Cannot read client certificate file "${path}".`, { cause: e });
        }
      };
      const [cert, key, pfx] = await Promise.all([load(auth.certPath), load(auth.keyPath), load(auth.pfxPath)]);
      if (!pfx && !(cert && key)) throw new ReqvynError('AUTH', 'Client certificate auth requires a PFX/P12 file or a certificate and key file.');
      return { url, headers, tls: { cert, key, pfx, passphrase: r(auth.passphrase) || undefined }, description: 'TLS client certificate' };
    }
  }
}

/**
 * If the response is a 401 with a supported challenge for the configured auth (currently Digest),
 * return the headers for a retry. Returns undefined when no retry should be made.
 */
export function answerChallenge(
  auth: ConcreteAuth,
  req: { method: string; url: string; headers: Array<[string, string]> },
  response: { status: number; headers: Array<[string, string]> },
  ctx: Pick<AuthContext, 'resolve'>,
  nc = 1,
): Array<[string, string]> | undefined {
  if (auth.type !== 'digest' || response.status !== 401) return undefined;
  const header = response.headers.filter(([k]) => k.toLowerCase() === 'www-authenticate').map(([, v]) => v);
  const challenge = header.map(parseDigestChallenge).find(Boolean);
  if (!challenge) return undefined;
  const u = new URL(req.url);
  const value = buildDigestAuthorization(challenge, {
    username: ctx.resolve(auth.username),
    password: ctx.resolve(auth.password),
    method: req.method,
    uri: u.pathname + u.search,
    nc,
  });
  return setHeader(req.headers, 'Authorization', value);
}
