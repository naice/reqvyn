import { createHash, randomBytes } from 'node:crypto';

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm: string;
  stale?: boolean;
}

/** Parse a `WWW-Authenticate: Digest ...` header. Returns undefined if not a digest challenge. */
export function parseDigestChallenge(header: string | undefined): DigestChallenge | undefined {
  if (!header) return undefined;
  const idx = header.search(/digest\s/i);
  if (idx === -1) return undefined;
  const params: Record<string, string> = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g;
  for (const m of header.slice(idx + 7).matchAll(re)) params[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  if (!params.nonce) return undefined;
  return {
    realm: params.realm ?? '',
    nonce: params.nonce,
    qop: params.qop,
    opaque: params.opaque,
    algorithm: (params.algorithm ?? 'MD5').toUpperCase(),
    stale: params.stale?.toLowerCase() === 'true',
  };
}

function hashFor(algorithm: string): (s: string) => string {
  const base = algorithm.replace(/-SESS$/, '');
  const name = base === 'SHA-256' ? 'sha256' : base === 'SHA-512-256' ? 'sha512-256' : 'md5';
  return (s: string) => createHash(name).update(s).digest('hex');
}

/** Compute the `Authorization: Digest ...` header (RFC 7616, qop=auth). */
export function buildDigestAuthorization(
  challenge: DigestChallenge,
  opts: { username: string; password: string; method: string; uri: string; nc?: number; cnonce?: string },
): string {
  const H = hashFor(challenge.algorithm);
  const cnonce = opts.cnonce ?? randomBytes(8).toString('hex');
  const nc = (opts.nc ?? 1).toString(16).padStart(8, '0');
  const qop = challenge.qop
    ?.split(',')
    .map((q) => q.trim())
    .find((q) => q === 'auth');
  let ha1 = H(`${opts.username}:${challenge.realm}:${opts.password}`);
  if (challenge.algorithm.endsWith('-SESS')) ha1 = H(`${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = H(`${opts.method.toUpperCase()}:${opts.uri}`);
  const response = qop ? H(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${challenge.nonce}:${ha2}`);
  const parts = [
    `username="${opts.username.replace(/"/g, '\\"')}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${opts.uri}"`,
    `algorithm=${challenge.algorithm}`,
    `response="${response}"`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (challenge.opaque !== undefined) parts.push(`opaque="${challenge.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}
