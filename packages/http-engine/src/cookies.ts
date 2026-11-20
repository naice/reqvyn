import type { Cookie } from '@reqvyn/core';

/**
 * A small RFC 6265-style cookie jar. Supports domain/host-only matching, path matching,
 * Expires / Max-Age, Secure and serialization for persistence.
 */
export interface StoredCookie extends Cookie {
  domain: string;
  path: string;
  hostOnly: boolean;
  /** Expiry as epoch ms; undefined = session cookie. */
  expiresAt?: number;
  createdAt: number;
}

export function parseSetCookie(header: string, requestUrl: URL, now = Date.now()): StoredCookie | null {
  const parts = header.split(';');
  const first = parts.shift();
  if (!first) return null;
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
  if (!name) return null;
  const cookie: StoredCookie = {
    name,
    value,
    domain: requestUrl.hostname.toLowerCase(),
    path: defaultPath(requestUrl.pathname),
    hostOnly: true,
    createdAt: now,
  };
  for (const attr of parts) {
    const i = attr.indexOf('=');
    const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? '' : attr.slice(i + 1).trim();
    switch (key) {
      case 'domain': {
        const d = val.replace(/^\./, '').toLowerCase();
        if (!d) break;
        if (!domainMatches(requestUrl.hostname.toLowerCase(), d)) return null; // reject foreign domains
        cookie.domain = d;
        cookie.hostOnly = false;
        break;
      }
      case 'path':
        if (val.startsWith('/')) cookie.path = val;
        break;
      case 'expires': {
        const t = Date.parse(val);
        if (!Number.isNaN(t) && cookie.maxAge === undefined) {
          cookie.expiresAt = t;
          cookie.expires = new Date(t).toISOString();
        }
        break;
      }
      case 'max-age': {
        const n = Number.parseInt(val, 10);
        if (!Number.isNaN(n)) {
          cookie.maxAge = n;
          cookie.expiresAt = now + n * 1000;
          cookie.expires = new Date(cookie.expiresAt).toISOString();
        }
        break;
      }
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite':
        cookie.sameSite = val;
        break;
    }
  }
  return cookie;
}

function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const idx = pathname.lastIndexOf('/');
  return idx <= 0 ? '/' : pathname.slice(0, idx);
}

export function domainMatches(host: string, domain: string): boolean {
  if (host === domain) return true;
  return host.endsWith('.' + domain) && !/^\d+\.\d+\.\d+\.\d+$/.test(host);
}

function pathMatches(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (reqPath.startsWith(cookiePath)) return cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/';
  return false;
}

export class CookieJar {
  private cookies: StoredCookie[] = [];

  setCookie(header: string, url: string | URL, now = Date.now()): StoredCookie | null {
    const u = typeof url === 'string' ? new URL(url) : url;
    const c = parseSetCookie(header, u, now);
    if (!c) return null;
    this.cookies = this.cookies.filter((x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path));
    if (c.expiresAt === undefined || c.expiresAt > now) this.cookies.push(c);
    return c;
  }

  /** Cookies applicable to the URL, longest path first (RFC 6265 §5.4). */
  getCookies(url: string | URL, now = Date.now()): StoredCookie[] {
    const u = typeof url === 'string' ? new URL(url) : url;
    this.purgeExpired(now);
    const host = u.hostname.toLowerCase();
    const secure = u.protocol === 'https:';
    return this.cookies
      .filter((c) => (c.hostOnly ? host === c.domain : domainMatches(host, c.domain)))
      .filter((c) => pathMatches(u.pathname || '/', c.path))
      .filter((c) => !c.secure || secure || host === 'localhost' || host === '127.0.0.1')
      .sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt);
  }

  getCookieHeader(url: string | URL): string {
    return this.getCookies(url)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  all(): StoredCookie[] {
    this.purgeExpired(Date.now());
    return [...this.cookies];
  }

  delete(domain: string, name?: string): void {
    this.cookies = this.cookies.filter((c) => !(c.domain === domain && (name === undefined || c.name === name)));
  }

  clear(): void {
    this.cookies = [];
  }

  private purgeExpired(now: number): void {
    this.cookies = this.cookies.filter((c) => c.expiresAt === undefined || c.expiresAt > now);
  }

  toJSON(): StoredCookie[] {
    return this.all().filter((c) => c.expiresAt !== undefined); // persist only persistent cookies
  }

  static fromJSON(data: unknown): CookieJar {
    const jar = new CookieJar();
    if (Array.isArray(data)) {
      for (const c of data) {
        if (c && typeof c === 'object' && typeof c.name === 'string' && typeof c.domain === 'string') jar.cookies.push(c as StoredCookie);
      }
    }
    return jar;
  }
}

/** Parse a request `Cookie` header into name/value pairs. */
export function parseCookieHeader(header: string): Array<{ name: string; value: string }> {
  return header
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return i === -1 ? { name: p, value: '' } : { name: p.slice(0, i), value: p.slice(i + 1) };
    });
}
