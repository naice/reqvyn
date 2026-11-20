import { describe, expect, it } from 'vitest';
import { childCount, childPath, copyableValue, jsonChildren, jsonKind, pathFromSegments, previewValue } from '../src/lib/jsonTree';

describe('jsonTree', () => {
  it('classifies kinds', () => {
    expect([null, [], {}, 's', 1, true].map(jsonKind)).toEqual(['null', 'array', 'object', 'string', 'number', 'boolean']);
  });
  it('builds JSONPath expressions', () => {
    expect(pathFromSegments(['data', 0, 'id'])).toBe('$.data[0].id');
    expect(childPath('$', 'weird key')).toBe("$['weird key']");
    expect(childPath('$', "it's")).toBe("$['it\\'s']");
  });
  it('lists children lazily', () => {
    expect(jsonChildren([1, 2, 3, 4], 1, 2)).toEqual([
      { key: 1, value: 2 },
      { key: 2, value: 3 },
    ]);
    expect(jsonChildren({ a: 1, b: 2, c: 3 }, 1, 1)).toEqual([{ key: 'b', value: 2 }]);
    expect(jsonChildren({ a: 1, b: 2 })).toHaveLength(2);
    expect(jsonChildren(5)).toEqual([]);
    expect(childCount({ a: 1 })).toBe(1);
    expect(childCount('x')).toBe(0);
  });
  it('previews and copies values', () => {
    expect(previewValue([1, 2])).toBe('Array(2)');
    expect(previewValue({ a: 1 })).toBe('{1 key}');
    expect(previewValue({ a: 1, b: 2 })).toBe('{2 keys}');
    expect(previewValue('abc')).toBe('"abc"');
    expect(previewValue('x'.repeat(100), 10)).toHaveLength(10);
    expect(copyableValue('raw')).toBe('raw');
    expect(copyableValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
