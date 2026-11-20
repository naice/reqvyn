import { describe, expect, it } from 'vitest';
import type { KeyValue } from '@reqvyn/core';
import { SECRET_PLACEHOLDER, changedSecrets, parseBulk, toBulk } from '../src/lib/bulk';

let n = 0;
const makeId = () => `id${++n}`;

describe('toBulk', () => {
  it('serialises rows, masks secrets and marks disabled rows', () => {
    const rows: KeyValue[] = [
      { id: '1', key: 'a', value: '1', enabled: true },
      { id: '2', key: 'b', value: '2', enabled: false },
      { id: '3', key: 'pw', value: 'hunter2', enabled: true, secret: true },
      { id: '4', key: '', value: '', enabled: true },
    ];
    const text = toBulk(rows);
    expect(text).toBe(`a=1\n//b=2\npw=${SECRET_PLACEHOLDER}`);
    expect(text).not.toContain('hunter2');
  });
});

describe('parseBulk', () => {
  it('parses = and : separators, comments, blanks and disabled lines', () => {
    const rows = parseBulk('# comment\n\na=1=2\nContent-Type: application/json\n// off = x\nflag', [], makeId);
    expect(rows.map(({ key, value, enabled }) => ({ key, value, enabled }))).toEqual([
      { key: 'a', value: '1=2', enabled: true },
      { key: 'Content-Type', value: 'application/json', enabled: true },
      { key: 'off', value: ' x', enabled: false },
      { key: 'flag', value: '', enabled: true },
    ]);
  });
  it('preserves ids and metadata of existing rows by key', () => {
    const existing: KeyValue[] = [{ id: 'keep', key: 'a', value: 'old', enabled: true, description: 'd' }];
    const [row] = parseBulk('a=new', existing, makeId);
    expect(row).toEqual({ id: 'keep', key: 'a', value: 'new', enabled: true, description: 'd' });
  });
  it('keeps the stored secret when the placeholder is unchanged', () => {
    const existing: KeyValue[] = [{ id: 's', key: 'pw', value: 'masked', enabled: true, secret: true }];
    expect(parseBulk(`pw=${SECRET_PLACEHOLDER}`, existing)[0]!.value).toBe('masked');
    const changed = parseBulk('pw=newpass', existing);
    expect(changed[0]!.value).toBe('newpass');
    expect(changedSecrets(existing, changed)).toEqual([{ key: 'pw', value: 'newpass' }]);
    expect(changedSecrets(existing, parseBulk(`pw=${SECRET_PLACEHOLDER}`, existing))).toEqual([]);
  });
  it('round-trips toBulk output', () => {
    const rows: KeyValue[] = [
      { id: '1', key: 'a', value: '1', enabled: true },
      { id: '2', key: 'b', value: 'two', enabled: false },
    ];
    expect(parseBulk(toBulk(rows), rows)).toEqual(rows);
  });
});
