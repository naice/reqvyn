import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToText, charsetOf, hexDump } from '../src/lib/base64';

describe('base64 helpers', () => {
  it('decodes base64 and text', () => {
    expect(Array.from(base64ToBytes('AAH/'))).toEqual([0, 1, 255]);
    expect(bytesToText(base64ToBytes('aGk='))).toBe('hi');
    expect(bytesToText(new Uint8Array([104, 105]), 'not-a-charset')).toBe('hi');
  });
  it('extracts the charset', () => {
    expect(charsetOf('text/html; charset="ISO-8859-1"')).toBe('iso-8859-1');
    expect(charsetOf('application/json')).toBe('utf-8');
  });
  it('produces a hex dump with ascii column and truncation notice', () => {
    expect(hexDump(new Uint8Array([0x48, 0x69, 0x00, 0xff]))).toBe(`00000000  ${'48 69 00 ff'.padEnd(47)}  Hi..`);
    const long = hexDump(new Uint8Array(40), 32);
    expect(long.split('\n')).toHaveLength(3);
    expect(long).toContain('… 8 more bytes');
  });
});
