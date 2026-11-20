import { describe, expect, it } from 'vitest';
import { CookieJar, parseSetCookie, domainMatches, parseCookieHeader } from '../src/index.js';

describe('cookies', () => {
  it('parses Set-Cookie attributes', () => {
    const c = parseSetCookie('id=42; Domain=example.com; Path=/api; Secure; HttpOnly; SameSite=Lax; Max-Age=60', new URL('https://www.example.com/'), 0);
    expect(c).toMatchObject({ name: 'id', value: '42', domain: 'example.com', path: '/api', secure: true, httpOnly: true });
  });

  it('rejects cookies for foreign domains', () => {
    expect(parseSetCookie('a=1; Domain=evil.com', new URL('https://example.com/'))).toBeNull();
  });

  it('matches domains and paths', () => {
    expect(domainMatches('api.example.com', 'example.com')).toBe(true);
    expect(domainMatches('badexample.com', 'example.com')).toBe(false);
    const jar = new CookieJar();
    jar.setCookie('a=1; Path=/api', 'http://example.com/api/x');
    expect(jar.getCookieHeader('http://example.com/api/y')).toBe('a=1');
    expect(jar.getCookieHeader('http://example.com/other')).toBe('');
  });

  it('does not send Secure cookies over http', () => {
    const jar = new CookieJar();
    jar.setCookie('s=1; Secure', 'https://example.com/');
    expect(jar.getCookieHeader('http://example.com/')).toBe('');
    expect(jar.getCookieHeader('https://example.com/')).toBe('s=1');
  });

  it('expires cookies and supports deletion and serialization', () => {
    const jar = new CookieJar();
    jar.setCookie('a=1; Max-Age=0', 'http://example.com/');
    expect(jar.all()).toHaveLength(0);
    jar.setCookie('b=2; Max-Age=3600', 'http://example.com/');
    jar.setCookie('session=1', 'http://example.com/');
    // only persistent cookies are serialized
    const restored = CookieJar.fromJSON(JSON.parse(JSON.stringify(jar)));
    expect(restored.getCookieHeader('http://example.com/')).toBe('b=2');
    restored.delete('example.com', 'b');
    expect(restored.all()).toHaveLength(0);
  });

  it('parses Cookie headers', () => {
    expect(parseCookieHeader('a=1; b=two')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: 'two' },
    ]);
  });
});
