import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalPath(pathname: string, service: string): string {
  if (service === 's3') return pathname || '/';
  // Normalize and double-encode segments as required for non-S3 services.
  const segments = (pathname || '/').split('/').map((seg) => encodeRfc3986(decodeSafe(seg)));
  return segments.join('/') || '/';
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Sign a request with AWS Signature Version 4. Returns the headers to add
 * (Authorization, X-Amz-Date, X-Amz-Content-Sha256, X-Amz-Security-Token).
 */
export function signAwsV4(
  req: { method: string; url: string; headers: Array<[string, string]>; payloadHash: string },
  creds: AwsCredentials,
  date = new Date(),
): Array<[string, string]> {
  const url = new URL(req.url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const added: Array<[string, string]> = [
    ['X-Amz-Date', amzDate],
    ['X-Amz-Content-Sha256', req.payloadHash],
  ];
  if (creds.sessionToken) added.push(['X-Amz-Security-Token', creds.sessionToken]);

  const headerMap = new Map<string, string[]>();
  const add = (k: string, v: string) => {
    const key = k.toLowerCase().trim();
    if (!headerMap.has(key)) headerMap.set(key, []);
    headerMap.get(key)!.push(v.trim().replace(/\s+/g, ' '));
  };
  add('host', url.host);
  for (const [k, v] of req.headers) {
    const lower = k.toLowerCase();
    if (lower === 'host' || lower === 'authorization' || lower === 'user-agent' || lower === 'content-length') continue;
    add(k, v);
  }
  for (const [k, v] of added) add(k, v);
  const signedHeaderNames = [...headerMap.keys()].sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${headerMap.get(k)!.join(',')}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [req.method.toUpperCase(), canonicalPath(url.pathname, creds.service), query, canonicalHeaders, signedHeaders, req.payloadHash].join('\n');
  const scope = `${dateStamp}/${creds.region}/${creds.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, creds.region);
  const kService = hmac(kRegion, creds.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  added.push(['Authorization', `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`]);
  return added;
}

export function sha256Payload(data: Buffer | string | undefined): string {
  return sha256(data ?? '');
}
