import { ReqvynError } from '@reqvyn/shared';

export interface QueryParam {
  key: string;
  value: string;
  /** Rows with `enabled: false` are ignored. */
  enabled?: boolean;
}

/**
 * Build the final URL. The URL text is the source of truth; enabled params that are not already
 * present in the URL's query string are appended (so both "query in URL" and "query in params table"
 * conventions work without duplication).
 */
export function buildUrl(rawUrl: string, params: QueryParam[] = [], opts: { encode?: boolean } = {}): string {
  let text = rawUrl.trim();
  if (!text) throw new ReqvynError('VALIDATION', 'The request URL is empty.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch (e) {
    throw new ReqvynError('VALIDATION', `Invalid URL: ${rawUrl}`, { cause: e, hint: 'Check that all {{variables}} in the URL are defined.' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ReqvynError('VALIDATION', `Unsupported protocol "${url.protocol}". Only http and https are supported.`);
  }
  const existing = parseQuery(url.search);
  const missing = params.filter((p) => p.key && p.enabled !== false && !existing.some((e) => e.key === p.key && e.value === p.value));
  if (missing.length === 0 && opts.encode !== false) return url.toString();
  const all = [...existing, ...missing];
  const encode = opts.encode !== false;
  const query = all
    .map(({ key, value }) => (encode ? `${encodeQueryComponent(key)}=${encodeQueryComponent(value)}` : `${key}=${value}`))
    .join('&');
  const base = `${url.protocol}//${url.username ? `${url.username}${url.password ? ':' + url.password : ''}@` : ''}${url.host}${url.pathname}`;
  return query ? `${base}?${query}${url.hash}` : `${base}${url.hash}`;
}

export function parseQuery(search: string): QueryParam[] {
  const s = search.startsWith('?') ? search.slice(1) : search;
  if (!s) return [];
  return s.split('&').filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    const k = i === -1 ? pair : pair.slice(0, i);
    const v = i === -1 ? '' : pair.slice(i + 1);
    return { key: safeDecode(k), value: safeDecode(v) };
  });
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

function encodeQueryComponent(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
