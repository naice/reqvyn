import { describe, expect, it } from 'vitest';
import { CODEGEN_TARGETS, createCollection, createFolder, createRequest, kv, parseCollection, type HttpRequest } from '@reqvyn/core';
import { CODEGEN_LABELS, csString, generateCode, jsString, parseCurl, psString, pyString, shellQuote } from '../src/index.js';

const TRICKY = `O'Brien "q" \`tick\` $var \\ back`;

function jsonRequest(): HttpRequest {
  return createRequest({
    name: 'Create',
    method: 'POST',
    url: 'https://api.example.test/items',
    params: [kv('q', 'a b&c'), kv('off', 'x', { enabled: false })],
    headers: [kv('X-Note', TRICKY), kv('Accept', 'application/json')],
    body: { mode: 'json', text: '{"msg":"it\'s \\"quoted\\""}' },
    auth: { type: 'bearer', token: 'literal-secret-token', prefix: 'Bearer' },
  });
}

function multipartRequest(): HttpRequest {
  return createRequest({
    name: 'Upload',
    method: 'PUT',
    url: 'https://api.example.test/up',
    body: {
      mode: 'multipart',
      parts: [
        { id: 'a', key: 'title', enabled: true, type: 'text', value: 'hi' },
        { id: 'b', key: 'file', enabled: true, type: 'file', value: '', filePath: '/tmp/a b.png' },
      ],
    },
    auth: { type: 'basic', username: 'user', password: 'pass-fake' },
  });
}

describe('string escapers', () => {
  it('shell', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('simple-value_1')).toBe('simple-value_1');
    expect(shellQuote('$HOME `x`')).toBe(`'$HOME \`x\`'`);
  });
  it('javascript', () => {
    expect(jsString('a"b\\c\n\u2028')).toBe('"a\\"b\\\\c\\n\\u2028"');
  });
  it('python', () => {
    expect(pyString('a"b\\c\n\t')).toBe('"a\\"b\\\\c\\n\\t"');
  });
  it('c#', () => {
    expect(csString('a"b\\c\n')).toBe('"a\\"b\\\\c\\n"');
  });
  it('powershell', () => {
    expect(psString("it's $x `y`")).toBe(`'it''s $x \`y\`'`);
    expect(psString('a\u2019b')).toBe("'a\u2019\u2019b'");
  });
});

describe('generateCode', () => {
  it('has a label for every target', () => {
    for (const t of CODEGEN_TARGETS) expect(CODEGEN_LABELS[t]).toBeTruthy();
  });

  it('never embeds literal secrets by default, for every target', () => {
    for (const t of CODEGEN_TARGETS) {
      const a = generateCode(t, jsonRequest());
      expect(a.code, t).not.toContain('literal-secret-token');
      expect(a.code, t).toContain('<TOKEN>');
      const b = generateCode(t, multipartRequest());
      expect(b.code, t).not.toContain('pass-fake');
      const c = generateCode(t, jsonRequest(), { includeSecrets: true });
      expect(c.code, t).toContain('literal-secret-token');
    }
  });

  it('curl: method, headers, body and escaping (and re-parses)', () => {
    const { code, language } = generateCode('curl', jsonRequest());
    expect(language).toBe('shellscript');
    expect(code).toContain(`'https://api.example.test/items?q=a%20b%26c'`);
    expect(code).not.toContain('off=x');
    expect(code).toContain(`-H 'X-Note: O'\\''Brien "q" \`tick\` $var \\ back'`);
    expect(code).toContain('--data-raw');
    expect(code).not.toContain('-X POST');
    const back = parseCurl(code).request;
    expect(back.method).toBe('POST');
    expect(back.headers.find((h) => h.key === 'X-Note')?.value).toBe(TRICKY);
    expect(back.body).toMatchObject({ mode: 'json', text: '{"msg":"it\'s \\"quoted\\""}' });
    const m = generateCode('curl', multipartRequest(), { includeSecrets: true }).code;
    expect(m).toContain('-X PUT');
    expect(m).toContain('--form-string title=hi');
    expect(m).toContain(`-F 'file=@/tmp/a b.png'`);
    expect(m).toContain('-u user:pass-fake');
    const insecure = generateCode('curl', createRequest({ name: 'x', method: 'GET', url: 'https://x.test', settings: { verifyTls: false } }));
    expect(insecure.code).toContain('-k');
    expect(insecure.warnings.some((w) => w.code === 'insecure')).toBe(true);
    expect(generateCode('curl', createRequest({ name: 'h', method: 'HEAD', url: 'https://x.test' })).code).toContain('--head');
  });

  it('fetch', () => {
    const { code, language } = generateCode('fetch', jsonRequest());
    expect(language).toBe('javascript');
    expect(code).toContain('await fetch("https://api.example.test/items?q=a%20b%26c"');
    expect(code).toContain('method: "POST"');
    expect(code).toContain(`"X-Note": "O'Brien \\"q\\" \`tick\` $var \\\\ back"`);
    expect(code).toContain('"Content-Type": "application/json"');
    const m = generateCode('fetch', multipartRequest()).code;
    expect(m).toContain('new FormData()');
    expect(m).not.toContain('multipart/form-data');
  });

  it('typescript', () => {
    const { code, language } = generateCode('typescript', jsonRequest());
    expect(language).toBe('typescript');
    expect(code).toContain('async function main(): Promise<void>');
    expect(code).toContain('const response: Response = await fetch(');
  });

  it('node', () => {
    const { code } = generateCode('node', multipartRequest(), { includeSecrets: true });
    expect(code).toContain("import { openAsBlob } from 'node:fs'");
    expect(code).toContain('openAsBlob("/tmp/a b.png")');
    expect(code).toContain('Buffer.from("user:pass-fake").toString(\'base64\')');
  });

  it('python', () => {
    const { code, language } = generateCode('python', jsonRequest());
    expect(language).toBe('python');
    expect(code).toContain('import requests');
    expect(code).toContain('requests.request(');
    expect(code).toContain('"POST"');
    expect(code).toContain(`"X-Note": "O'Brien \\"q\\" \`tick\` $var \\\\ back"`);
    expect(code).toContain('timeout=30');
    const m = generateCode('python', multipartRequest(), { includeSecrets: true }).code;
    expect(m).toContain('files = [');
    expect(m).toContain('open("/tmp/a b.png", "rb")');
    expect(m).toContain('auth=("user", "pass-fake")');
  });

  it('csharp', () => {
    const { code, language } = generateCode('csharp', jsonRequest());
    expect(language).toBe('csharp');
    expect(code).toContain('new HttpClient(');
    expect(code).toContain('new HttpMethod("POST")');
    expect(code).toContain(`TryAddWithoutValidation("X-Note", "O'Brien \\"q\\" \`tick\` $var \\\\ back")`);
    expect(code).toContain('new StringContent(');
    const m = generateCode('csharp', multipartRequest()).code;
    expect(m).toContain('MultipartFormDataContent');
    expect(m).toContain('File.OpenRead("/tmp/a b.png")');
  });

  it('powershell', () => {
    const { code, language } = generateCode('powershell', jsonRequest());
    expect(language).toBe('powershell');
    expect(code).toContain('Invoke-RestMethod');
    expect(code).toContain('-Method Post');
    expect(code).toContain(`'X-Note' = 'O''Brien "q" \`tick\` $var \\ back'`);
    expect(code).toContain(`-ContentType 'application/json'`);
    const m = generateCode('powershell', multipartRequest()).code;
    expect(m).toContain('-Form $form');
    expect(m).toContain(`Get-Item -LiteralPath '/tmp/a b.png'`);
  });

  it('applies inherited collection headers/auth and substitutes variables', () => {
    const c = createCollection({ name: 'C', headers: [kv('X-Col', '1')], auth: { type: 'apikey', key: 'X-API-Key', value: '{{apiKey}}', in: 'header' } });
    const f = createFolder({ name: 'F', parentId: null, sortKey: 0, headers: [kv('X-Folder', '2')] });
    c.folders.push(f);
    const r = createRequest({ name: 'R', parentId: f.id, sortKey: 0, method: 'GET', url: '{{baseUrl}}/x' });
    c.requests.push(r);
    const col = parseCollection(c);
    const { code } = generateCode('curl', r, { collection: col, variables: { baseUrl: 'https://v.test' } });
    expect(code).toContain('curl https://v.test/x');
    expect(code).toContain("-H 'X-Col: 1'");
    expect(code).toContain("-H 'X-Folder: 2'");
    expect(code).toContain("-H 'X-API-Key: {{apiKey}}'");
  });

  it('uses placeholders for computed auth (OAuth2, JWT, AWS SigV4)', () => {
    const aws = generateCode('python', createRequest({ name: 'a', method: 'GET', url: 'https://x.test', auth: { type: 'awsv4', accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake', sessionToken: '', region: 'eu-west-1', service: 's3' } }));
    expect(aws.code).toContain('<AWS_SIGV4_AUTHORIZATION>');
    expect(aws.code).not.toContain('AKIAFAKE');
    expect(aws.warnings.some((w) => w.code === 'unsupported-feature')).toBe(true);
  });
});
