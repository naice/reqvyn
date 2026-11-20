import { describe, expect, it } from 'vitest';
import type { KeyValue } from '@reqvyn/core';
import { buildQuery, paramsEqual, paramsFromUrl, parseQuery, splitUrl, urlFromParams } from '../src/lib/url';

const kv = (id: string, key: string, value: string, enabled = true): KeyValue => ({ id, key, value, enabled });
let n = 0;
const makeId = () => `new${++n}`;

describe('splitUrl', () => {
  it('splits base, query and hash', () => {
    expect(splitUrl('https://x.io/a?b=1&c=2#frag')).toEqual({ base: 'https://x.io/a', query: 'b=1&c=2', hash: '#frag' });
  });
  it('returns null query when absent', () => {
    expect(splitUrl('https://x.io/a')).toEqual({ base: 'https://x.io/a', query: null, hash: '' });
  });
  it('ignores ? and # inside {{variables}}', () => {
    expect(splitUrl('{{base?x}}/p?q={{a#b}}')).toEqual({ base: '{{base?x}}/p', query: 'q={{a#b}}', hash: '' });
  });
});

describe('parseQuery / buildQuery', () => {
  it('parses pairs and keys without values, raw', () => {
    expect(parseQuery('a=1&b&c=%20x&&d=')).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '' },
      { key: 'c', value: '%20x' },
      { key: 'd', value: '' },
    ]);
    expect(parseQuery('')).toEqual([]);
  });
  it('builds from enabled non-blank params', () => {
    expect(buildQuery([kv('1', 'a', '1'), kv('2', 'b', ''), kv('3', 'c', '3', false), kv('4', '', '')])).toBe('a=1&b');
  });
});

describe('paramsFromUrl', () => {
  it('keeps ids of matching rows and disabled rows, appends new ones', () => {
    const existing = [kv('1', 'a', '1'), kv('2', 'off', 'x', false), kv('3', 'b', '2')];
    const out = paramsFromUrl('http://h/p?a=1&b=9&c=3', existing, makeId);
    expect(out[0]).toBe(existing[0]);
    expect(out[1]).toBe(existing[1]);
    expect(out[2]).toEqual({ id: '3', key: 'b', value: '9', enabled: true });
    expect(out[3]).toMatchObject({ key: 'c', value: '3', enabled: true });
    expect(out[3]!.id).toMatch(/^new/);
  });
  it('drops enabled rows removed from the URL', () => {
    const out = paramsFromUrl('http://h/p', [kv('1', 'a', '1'), kv('2', 'z', '', false)], makeId);
    expect(out.map((p) => p.id)).toEqual(['2']);
  });
});

describe('urlFromParams', () => {
  it('rebuilds query keeping the hash', () => {
    expect(urlFromParams('http://h/p?old=1#top', [kv('1', 'x', '{{v}}')])).toBe('http://h/p?x={{v}}#top');
    expect(urlFromParams('http://h/p?old=1', [])).toBe('http://h/p');
  });
  it('round-trips with paramsFromUrl', () => {
    const url = 'http://h/p?a=1&b={{tok}}';
    const params = paramsFromUrl(url, [], makeId);
    expect(urlFromParams(url, params)).toBe(url);
  });
});

describe('paramsEqual', () => {
  it('compares id/key/value/enabled', () => {
    expect(paramsEqual([kv('1', 'a', '1')], [kv('1', 'a', '1')])).toBe(true);
    expect(paramsEqual([kv('1', 'a', '1')], [kv('1', 'a', '2')])).toBe(false);
    expect(paramsEqual([kv('1', 'a', '1')], [])).toBe(false);
  });
});
