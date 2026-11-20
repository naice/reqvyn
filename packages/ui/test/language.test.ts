import { describe, expect, it } from 'vitest';
import { detectLanguage, isBinary, languageFromContentType, mimeOf } from '../src/lib/language';

const enc = (s: string) => new TextEncoder().encode(s);

describe('language detection', () => {
  it('extracts the mime type', () => {
    expect(mimeOf('Application/JSON; charset=utf-8')).toBe('application/json');
  });
  it('maps content types', () => {
    expect(languageFromContentType('application/problem+json')).toBe('json');
    expect(languageFromContentType('application/atom+xml')).toBe('xml');
    expect(languageFromContentType('text/html')).toBe('html');
    expect(languageFromContentType('application/javascript')).toBe('javascript');
    expect(languageFromContentType('application/x-yaml')).toBe('yaml');
    expect(languageFromContentType('text/plain')).toBe('text');
    expect(languageFromContentType('application/octet-stream')).toBeNull();
    expect(languageFromContentType('')).toBeNull();
  });
  it('sniffs when the content type is missing or generic', () => {
    expect(detectLanguage('', '{"a":1}')).toBe('json');
    expect(detectLanguage('text/plain', '[1,2]')).toBe('json');
    expect(detectLanguage('', '{not json')).toBe('text');
    expect(detectLanguage('', '<!DOCTYPE html><html></html>')).toBe('html');
    expect(detectLanguage('', '<?xml version="1.0"?><a/>')).toBe('xml');
    expect(detectLanguage('text/plain', 'hello')).toBe('text');
    expect(detectLanguage('application/json', 'garbage')).toBe('json');
  });
  it('detects binary bodies', () => {
    expect(isBinary('image/png', enc('x'))).toBe(true);
    expect(isBinary('image/svg+xml', enc('<svg/>'))).toBe(false);
    expect(isBinary('application/pdf', enc('%PDF'))).toBe(true);
    expect(isBinary('application/json', new Uint8Array([0, 1]))).toBe(false);
    expect(isBinary('', new Uint8Array([65, 0, 66]))).toBe(true);
    expect(isBinary('', enc('plain'))).toBe(false);
  });
});
