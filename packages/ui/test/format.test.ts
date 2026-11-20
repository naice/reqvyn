import { describe, expect, it } from 'vitest';
import { formatJson, formatXml, statusClass, tryFormatJson } from '../src/lib/format';

describe('formatJson', () => {
  it('pretty prints JSON', () => {
    expect(formatJson('{"a":1,"b":[1,2]}')).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
  });
  it('keeps bare and in-string {{variables}}', () => {
    expect(formatJson('{"id":{{userId}},"name":"hi {{name}}"}')).toBe('{\n  "id": {{userId}},\n  "name": "hi {{name}}"\n}');
  });
  it('handles escaped quotes', () => {
    expect(formatJson('{"a":"x\\"{{v}}"}')).toBe('{\n  "a": "x\\"{{v}}"\n}');
  });
  it('tryFormatJson returns null on invalid input', () => {
    expect(tryFormatJson('{bad')).toBeNull();
    expect(tryFormatJson('[1]')).toBe('[\n  1\n]');
  });
});

describe('formatXml', () => {
  it('indents nested elements and keeps simple text inline', () => {
    expect(formatXml('<?xml version="1.0"?><a><b>text</b><c/><!-- note --></a>')).toBe(
      '<?xml version="1.0"?>\n<a>\n  <b>text</b>\n  <c/>\n  <!-- note -->\n</a>',
    );
  });
});

describe('statusClass', () => {
  it('buckets status codes', () => {
    expect([101, 204, 302, 404, 503, 0, 700].map(statusClass)).toEqual(['info', 'success', 'redirect', 'client-error', 'server-error', 'unknown', 'unknown']);
  });
});
