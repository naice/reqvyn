import { createHmac, createSign, createPrivateKey } from 'node:crypto';
import { ReqvynError } from '@reqvyn/shared';

export type JwtAlgorithm = 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384';

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch (e) {
    throw new ReqvynError('AUTH', `JWT ${what} is not valid JSON.`, { cause: e });
  }
  throw new ReqvynError('AUTH', `JWT ${what} must be a JSON object.`);
}

/** Create a signed JWT. `secret` is an HMAC secret (HS*) or a PEM private key (RS/ES algorithms). */
export function signJwt(opts: {
  algorithm: JwtAlgorithm;
  secret: string;
  secretBase64?: boolean;
  payload: string;
  header?: string;
  expiresInSeconds?: number;
  now?: number;
}): string {
  if (!opts.secret) throw new ReqvynError('AUTH', 'JWT signing key/secret is empty.');
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const header = { alg: opts.algorithm, typ: 'JWT', ...parseJsonObject(opts.header ?? '', 'header') };
  const payload = parseJsonObject(opts.payload, 'payload');
  if (payload.iat === undefined) payload.iat = nowSec;
  if (opts.expiresInSeconds && payload.exp === undefined) payload.exp = nowSec + opts.expiresInSeconds;
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const bits = opts.algorithm.slice(2);
  let signature: Buffer;
  if (opts.algorithm.startsWith('HS')) {
    const key = opts.secretBase64 ? Buffer.from(opts.secret, 'base64') : Buffer.from(opts.secret, 'utf8');
    signature = createHmac(`sha${bits}`, key).update(signingInput).digest();
  } else {
    let key;
    try {
      key = createPrivateKey(opts.secret);
    } catch (e) {
      throw new ReqvynError('AUTH', `JWT ${opts.algorithm} requires a PEM private key.`, { cause: e });
    }
    const signer = createSign(`SHA${bits}`);
    signer.update(signingInput);
    signature = opts.algorithm.startsWith('ES') ? signer.sign({ key, dsaEncoding: 'ieee-p1363' }) : signer.sign(key);
  }
  return `${signingInput}.${b64url(signature)}`;
}

/** Decode (without verifying) a JWT – used to display token contents. */
export function decodeJwt(token: string): { header: unknown; payload: unknown } | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')),
      payload: JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')),
    };
  } catch {
    return undefined;
  }
}
