import { describe, expect, it } from 'vitest';
import type { Extraction } from '@reqvyn/core';
import { runExtractions, type ResponseContext } from '../src/index.js';

const ctx: ResponseContext = {
  status: 201,
  statusText: 'Created',
  headers: [
    ['Location', '/users/42'],
    ['X-Multi', 'a'],
    ['x-multi', 'b'],
    ['Set-Cookie', 'raw=fromHeader; Path=/'],
  ],
  bodyText: JSON.stringify({ token: 'tok-123', user: { id: 42, roles: ['a', 'b'] }, list: [{ id: 1 }, { id: 2 }] }),
  timeMs: 10,
  size: 100,
  cookies: [{ name: 'sid', value: 'cookie-value' }],
  contentType: 'application/json',
};

let n = 0;
function x(source: Extraction['source'], path: string, extra: Partial<Extraction> = {}): Extraction {
  return { id: `x${++n}`, enabled: true, variable: `v${n}`, source, path, scope: 'runtime', ...extra };
}

describe('runExtractions', () => {
  it('extracts JSON values; objects and multi-matches become JSON strings', () => {
    const r = runExtractions(
      [x('json', '$.token'), x('json', 'user.id'), x('json', '$.user.roles'), x('json', '$.list[*].id'), x('json', '$.user'), x('json', '$.missing'), x('json', '')],
      ctx,
    );
    expect(r.map((e) => e.value ?? `ERR:${e.error}`)).toEqual([
      'tok-123',
      '42',
      '["a","b"]',
      '[1,2]',
      '{"id":42,"roles":["a","b"]}',
      'ERR:JSONPath $.missing matched nothing',
      ctx.bodyText,
    ]);
  });

  it('extracts headers (case-insensitive, combined), status, body', () => {
    const r = runExtractions([x('header', 'location'), x('header', 'X-MULTI'), x('header', 'nope'), x('status', ''), x('body', '')], ctx);
    expect(r[0]!.value).toBe('/users/42');
    expect(r[1]!.value).toBe('a, b');
    expect(r[2]!.error).toMatch(/Header "nope" not found/);
    expect(r[3]!.value).toBe('201');
    expect(r[4]!.value).toBe(ctx.bodyText);
  });

  it('extracts with regex (first capture group or whole match)', () => {
    const r = runExtractions([x('regex', '"token":"([^"]+)"'), x('regex', 'tok-\\d+'), x('regex', '/TOK-(\\d+)/i'), x('regex', 'zzz'), x('regex', '([')], ctx);
    expect(r[0]!.value).toBe('tok-123');
    expect(r[1]!.value).toBe('tok-123');
    expect(r[2]!.value).toBe('123');
    expect(r[3]!.error).toMatch(/did not match/);
    expect(r[4]!.error).toMatch(/Invalid regular expression/);
  });

  it('extracts cookies from parsed cookies and Set-Cookie headers', () => {
    const r = runExtractions([x('cookie', 'sid'), x('cookie', 'raw'), x('cookie', 'none')], ctx);
    expect(r[0]!.value).toBe('cookie-value');
    expect(r[1]!.value).toBe('fromHeader');
    expect(r[2]!.error).toMatch(/Cookie "none" not found/);
  });

  it('keeps scope/variable/id, skips disabled, reports errors', () => {
    const r = runExtractions(
      [x('status', '', { scope: 'environment', variable: 'code', id: 'e1' }), x('status', '', { enabled: false }), x('status', '', { variable: ' ' })],
      ctx,
    );
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ id: 'e1', variable: 'code', scope: 'environment', value: '201' });
    expect(r[1]!.error).toMatch(/No target variable/);
    const bad = runExtractions([x('json', '$.a'), x('json', '$[')], { ...ctx, bodyText: 'not json' });
    expect(bad[0]!.error).toMatch(/not valid JSON/);
    const badPath = runExtractions([x('json', '$[')], ctx);
    expect(badPath[0]!.error).toMatch(/Invalid JSONPath/);
  });
});
