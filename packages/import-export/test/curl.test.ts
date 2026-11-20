import { describe, expect, it } from 'vitest';
import { parseRequest } from '@reqvyn/core';
import { importCurl, parseCurl, splitCurlCommands, tokenizeShell, exportCurl } from '../src/index.js';
import { expectValid, fixture, kvMap } from './helpers.js';

describe('cURL importer', () => {
  it('imports a multi-command script', () => {
    const res = importCurl(fixture('curl/commands.sh'), 'commands.sh');
    expectValid(res);
    const [a, b, c] = res.collections[0]!.requests;
    expect(res.collections[0]!.requests).toHaveLength(3);
    expect(a).toMatchObject({ method: 'POST', url: 'https://api.example.test/items' });
    expect(kvMap(a!.params)).toEqual({ x: '1' });
    expect(a!.headers.find((h) => h.key === 'Authorization')?.value).toBe('Bearer {{token}}');
    expect(a!.body).toEqual({ mode: 'json', text: `{"name":"it's"}` });
    expect(b!.method).toBe('GET');
    expect(kvMap(b!.params)).toEqual({ q: 'hello world', page: '2' });
    expect(b!.settings).toMatchObject({ verifyTls: false, followRedirects: true, timeoutMs: 5000 });
    expect(c!.auth).toEqual({ type: 'basic', username: 'demo', password: 'not-a-real-password' });
    expect(c!.method).toBe('POST');
    expect(c!.body.mode).toBe('multipart');
    if (c!.body.mode === 'multipart') {
      expect(c!.body.parts[0]).toMatchObject({ key: 'file', type: 'file', filePath: './photo.jpg', contentType: 'image/jpeg' });
      expect(c!.body.parts[1]).toMatchObject({ key: 'caption', type: 'text', value: 'hi' });
    }
    expect(res.warnings.some((w) => w.code === 'insecure')).toBe(true);
  });

  it('handles quoting: single, double, ANSI escapes inside double quotes and adjacent strings', () => {
    expect(tokenizeShell(`curl 'a b' "c \\"d\\"" e'f'"g" \\$HOME`)).toEqual(['curl', 'a b', 'c "d"', 'efg', '$HOME']);
    const { request } = parseCurl(`curl "https://x.test/p" -H "X-Quote: say \\"hi\\""`);
    expect(request.headers[0]).toMatchObject({ key: 'X-Quote', value: 'say "hi"' });
  });

  it('handles backslash continuations (bash)', () => {
    const { request } = parseCurl('curl \\\n  -X PUT \\\n  https://x.test/a \\\n  -d "k=v"');
    expect(request.method).toBe('PUT');
    expect(request.body).toMatchObject({ mode: 'urlencoded' });
  });

  it('handles caret continuations and escapes (Windows cmd)', () => {
    const cmd = 'curl ^"https://x.test/a?b=1^&c=2^" ^\n  -H ^"Accept: application/json^" ^\n  --data-raw ^"^{^\\^"a^\\^":1^}^"';
    const { request } = parseCurl(cmd);
    expect(request.url).toBe('https://x.test/a');
    expect(kvMap(request.params)).toEqual({ b: '1', c: '2' });
    expect(request.headers[0]).toMatchObject({ key: 'Accept', value: 'application/json' });
    expect(request.method).toBe('POST');
    expect(request.body).toMatchObject({ mode: 'json', text: '{"a":1}' });
  });

  it('handles PowerShell backtick continuations', () => {
    const { request } = parseCurl('curl.exe `\n  -X DELETE `\n  https://x.test/items/1');
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe('https://x.test/items/1');
  });

  it('-G moves data to the query string; --data-urlencode encodes', () => {
    const { request } = parseCurl(`curl -G https://x.test/s --data-urlencode "q=a&b c" --data-urlencode "=raw value" -d x=1`);
    expect(request.method).toBe('GET');
    expect(request.body.mode).toBe('none');
    expect(request.params.map((p) => [p.key, p.value])).toEqual([
      ['q', 'a&b c'],
      ['raw value', ''],
      ['x', '1'],
    ]);
  });

  it('-u with digest, -k, -I, -A, -e, -b and combined short flags', () => {
    const { request, warnings } = parseCurl(`curl -skL --digest -u user:pa:ss -A agent/1 -e https://ref.test -b "a=1; b=2" -I https://x.test`);
    expect(request.auth).toEqual({ type: 'digest', username: 'user', password: 'pa:ss' });
    expect(request.method).toBe('HEAD');
    expect(request.settings).toMatchObject({ verifyTls: false, followRedirects: true });
    expect(kvMap(request.headers)).toMatchObject({ 'User-Agent': 'agent/1', Referer: 'https://ref.test' });
    expect(kvMap(request.cookies)).toEqual({ a: '1', b: '2' });
    expect(warnings.some((w) => w.code === 'insecure')).toBe(true);
  });

  it('-F with @file, <file, ;type= and --form-string', () => {
    const { request, warnings } = parseCurl(`curl https://x.test -F "a=@/tmp/a.bin" -F "b=<notes.txt" -F "c=v;type=text/plain" --form-string "d=@literal"`);
    expect(request.body.mode).toBe('multipart');
    if (request.body.mode !== 'multipart') return;
    const [a, b, c, d] = request.body.parts;
    expect(a).toMatchObject({ type: 'file', filePath: '/tmp/a.bin' });
    expect(b).toMatchObject({ type: 'file', filePath: 'notes.txt' });
    expect(c).toMatchObject({ type: 'text', value: 'v', contentType: 'text/plain' });
    expect(d).toMatchObject({ type: 'text', value: '@literal' });
    expect(warnings.some((w) => w.field === '--form')).toBe(true);
  });

  it('--json, --data-binary @file, -T, --url=, credentials in URL and unknown flags', () => {
    expect(parseCurl(`curl --json '{"a":1}' https://x.test`).request).toMatchObject({ method: 'POST', body: { mode: 'json', text: '{"a":1}' } });
    expect(parseCurl(`curl --data-binary @payload.bin -H 'Content-Type: application/octet-stream' https://x.test`).request.body).toMatchObject({
      mode: 'binary',
      filePath: 'payload.bin',
    });
    expect(parseCurl(`curl -T file.txt https://x.test/u`).request).toMatchObject({ method: 'PUT', body: { mode: 'binary', filePath: 'file.txt' } });
    expect(parseCurl(`curl --url=https://x.test/z`).request.url).toBe('https://x.test/z');
    const cred = parseCurl('curl https://bob:fake-pass@x.test/p');
    expect(cred.request.url).toBe('https://x.test/p');
    expect(cred.request.auth).toMatchObject({ type: 'basic', username: 'bob', password: 'fake-pass' });
    expect(cred.warnings.some((w) => w.code === 'secret')).toBe(true);
    const unk = parseCurl('curl --frobnicate https://x.test -o out.txt -s');
    expect(unk.warnings.some((w) => w.field === 'frobnicate')).toBe(true);
    expect(parseCurl('curl x.test/a').request.url).toBe('http://x.test/a');
  });

  it('rejects non-curl input and missing URLs', () => {
    expect(() => parseCurl('wget https://x.test')).toThrow();
    expect(() => parseCurl('curl -X POST')).toThrow(/URL/);
    expect(() => parseCurl("curl 'unterminated")).toThrow(/quote/);
  });

  it('splits commands and ignores comments', () => {
    expect(splitCurlCommands('# c\ncurl a\n\ncurl b -H "x: y"\n')).toHaveLength(2);
  });

  it('round-trips through the cURL exporter', () => {
    const { request } = parseCurl(`curl -X PATCH 'https://x.test/a?z=1' -H 'X-A: it'\\''s' --data-raw '{"a":"b"}' -H 'Content-Type: application/json'`);
    const out = exportCurl(parseRequest(request)).text;
    const back = parseCurl(out).request;
    expect(back.method).toBe('PATCH');
    expect(back.url).toBe('https://x.test/a');
    expect(kvMap(back.params)).toEqual({ z: '1' });
    expect(kvMap(back.headers)).toMatchObject({ 'X-A': "it's" });
    expect(back.body).toMatchObject({ mode: 'json', text: '{"a":"b"}' });
  });
});
