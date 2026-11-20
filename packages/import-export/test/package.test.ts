import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { createCollection, createEnvironment, createFolder, createRequest, kv, parseCollection, type Collection } from '@reqvyn/core';
import { isReqvynError } from '@reqvyn/shared';
import { buildPackage, createPackage, crc32, importFiles, looksLikeZip, readPackage, safeUnzip, validateEntryPath } from '../src/index.js';

function sample(): Collection {
  const c = createCollection({ name: 'Pkg', variables: [kv('baseUrl', 'https://pkg.example.test'), kv('apiToken', 'fake-api-token-123', { secret: true })] });
  const f = createFolder({ name: 'Folder', parentId: null, sortKey: 0 });
  const sub = createFolder({ name: 'Sub', parentId: f.id, sortKey: 0 });
  c.folders.push(f, sub);
  c.requests.push(
    createRequest({ name: 'A', parentId: f.id, sortKey: 0, method: 'GET', url: '{{baseUrl}}/a', auth: { type: 'bearer', token: 'literal-bearer-fake', prefix: 'Bearer' } }),
    createRequest({ name: 'B', parentId: sub.id, sortKey: 0, method: 'POST', url: '{{baseUrl}}/b', headers: [kv('Authorization', 'Basic ZmFrZTpmYWtl'), kv('X-Plain', 'ok')], body: { mode: 'json', text: '{"x":1}' } }),
    createRequest({ name: 'C', parentId: null, sortKey: 1, method: 'DELETE', url: '{{baseUrl}}/c', auth: { type: 'basic', username: 'u', password: '{{pw}}' } }),
  );
  return parseCollection(c);
}

const env = createEnvironment({ name: 'Dev', variables: [kv('baseUrl', 'http://localhost'), kv('pw', 'env-password-fake', { secret: true })] });

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return isReqvynError(e) ? e.code : `non-reqvyn:${String(e)}`;
  }
  return 'no-error';
}

function rezip(bytes: Uint8Array, mutate: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(bytes);
  mutate(files);
  return zipSync(files as Zippable);
}

describe('.reqvyn package', () => {
  it('round-trips a collection and environments', () => {
    const c = sample();
    const built = buildPackage(c, { environments: [env], includeEnvironmentValues: true, createdAt: '2025-01-01T00:00:00.000Z' });
    expect(looksLikeZip(built.bytes)).toBe(true);
    const read = readPackage(built.bytes);
    expect(read.manifest.format).toBe('reqvyn-package');
    expect(read.manifest.collection.name).toBe('Pkg');
    expect(read.collection.id).toBe(c.id);
    expect(read.collection.folders.map((f) => f.name).sort()).toEqual(['Folder', 'Sub']);
    expect(read.collection.requests.map((r) => [r.name, r.method, r.url, r.parentId])).toEqual(
      expect.arrayContaining(c.requests.map((r) => [r.name, r.method, r.url, r.parentId])),
    );
    expect(read.collection.requests.find((r) => r.name === 'B')!.body).toEqual({ mode: 'json', text: '{"x":1}' });
    expect(read.environments[0]!.name).toBe('Dev');
    expect(read.environments[0]!.variables.find((v) => v.key === 'baseUrl')!.value).toBe('http://localhost');
    expect(read.warnings).toEqual([]);
  });

  it('is deterministic for a fixed timestamp', () => {
    const c = sample();
    const a = createPackage(c, { createdAt: '2025-01-01T00:00:00.000Z' });
    const b = createPackage(c, { createdAt: '2025-01-01T00:00:00.000Z' });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('blanks secrets by default and reports them', () => {
    const built = buildPackage(sample(), { environments: [env] });
    const text = Object.values(unzipSync(built.bytes))
      .map((d) => new TextDecoder().decode(d))
      .join('\n');
    expect(text).not.toContain('literal-bearer-fake');
    expect(text).not.toContain('fake-api-token-123');
    expect(text).not.toContain('env-password-fake');
    expect(text).not.toContain('ZmFrZTpmYWtl');
    expect(text).toContain('{{pw}}');
    expect(text).toContain('X-Plain');
    expect(built.removed.length).toBeGreaterThanOrEqual(4);
    expect(built.manifest.options.includeSecrets).toBe(false);
  });

  it('keeps secrets only when explicitly asked and warns on read', () => {
    const built = buildPackage(sample(), { environments: [env], includeSecrets: true });
    const read = readPackage(built.bytes);
    expect(read.collection.requests.find((r) => r.name === 'A')!.auth).toMatchObject({ token: 'literal-bearer-fake' });
    expect(read.warnings.some((w) => w.code === 'secret')).toBe(true);
  });

  it('can export a subset of requests', () => {
    const c = sample();
    const b = c.requests.find((r) => r.name === 'B')!;
    const read = readPackage(createPackage(c, { requestIds: [b.id] }));
    expect(read.collection.requests.map((r) => r.name)).toEqual(['B']);
    expect(read.collection.folders.map((f) => f.name).sort()).toEqual(['Folder', 'Sub']);
  });

  it('detects tampering with a file', () => {
    const bytes = createPackage(sample());
    const tampered = rezip(bytes, (files) => {
      const path = Object.keys(files).find((p) => p.startsWith('collection/requests/'))!;
      const doc = JSON.parse(new TextDecoder().decode(files[path])) as { url: string };
      doc.url = 'https://evil.example.test/steal';
      files[path] = strToU8(JSON.stringify(doc));
    });
    expect(code(() => readPackage(tampered))).toBe('UNTRUSTED');
  });

  it('detects tampering with the manifest file list', () => {
    const bytes = createPackage(sample());
    const tampered = rezip(bytes, (files) => {
      const m = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as { files: Array<{ path: string; sha256: string; size: number }> };
      m.files[0]!.sha256 = '0'.repeat(64);
      files['manifest.json'] = strToU8(JSON.stringify(m));
    });
    expect(code(() => readPackage(tampered))).toBe('UNTRUSTED');
  });

  it('rejects a missing manifest, missing files and newer format versions', () => {
    const bytes = createPackage(sample());
    expect(code(() => readPackage(rezip(bytes, (f) => delete f['manifest.json'])))).toBe('VALIDATION');
    expect(code(() => readPackage(rezip(bytes, (f) => delete f['collection/collection.json'])))).toBe('VALIDATION');
    const newer = rezip(bytes, (files) => {
      const m = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as { formatVersion: number };
      m.formatVersion = 99;
      files['manifest.json'] = strToU8(JSON.stringify(m));
    });
    expect(code(() => readPackage(newer))).toBe('VALIDATION');
  });

  it('warns about (and ignores) unknown files', () => {
    const bytes = rezip(createPackage(sample()), (f) => {
      f['extra/readme.txt'] = strToU8('hello');
    });
    const read = readPackage(bytes);
    expect(read.warnings.some((w) => w.code === 'unknown-file' && w.message.includes('extra/readme.txt'))).toBe(true);
  });

  it('is imported through importFiles', () => {
    const res = importFiles([{ name: 'x.reqvyn', content: createPackage(sample(), { environments: [env] }) }]);
    expect(res.collections[0]!.name).toBe('Pkg');
    expect(res.environments).toHaveLength(1);
    const bad = importFiles([{ name: 'bad.reqvyn', content: new Uint8Array([1, 2, 3]) }]);
    expect(bad.collections).toHaveLength(0);
    expect(bad.warnings[0]!.code).toBe('failed');
  });
});

describe('safe ZIP extraction', () => {
  it('rejects zip-slip entry names', () => {
    for (const name of ['../evil.json', 'a/../../evil.json', '/abs.json', 'C:/win.json', 'a\\b.json', 'a/./b.json']) {
      expect(code(() => validateEntryPath(name)), name).toBe('UNTRUSTED');
    }
    expect(validateEntryPath('collection/requests/x.json')).toBe('collection/requests/x.json');
    const evil = zipSync({ 'manifest.json': strToU8('{}'), '../evil.json': strToU8('{}') });
    expect(code(() => safeUnzip(evil))).toBe('UNTRUSTED');
    expect(code(() => readPackage(evil))).toBe('UNTRUSTED');
  });

  it('rejects oversized entries and archives', () => {
    const big = zipSync({ 'big.json': new Uint8Array(64 * 1024).fill(32) }, { level: 0 });
    expect(code(() => safeUnzip(big, { maxEntryBytes: 1024 }))).toBe('TOO_LARGE');
    expect(code(() => safeUnzip(big, { maxTotalBytes: 1024 }))).toBe('TOO_LARGE');
    expect(code(() => safeUnzip(big, { maxArchiveBytes: 1024 }))).toBe('TOO_LARGE');
    expect(safeUnzip(big).get('big.json')!.length).toBe(64 * 1024);
  });

  it('rejects zip bombs (high compression ratio)', () => {
    const bomb = zipSync({ 'bomb.json': new Uint8Array(8 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(100 * 1024);
    expect(code(() => safeUnzip(bomb))).toMatch(/UNTRUSTED|TOO_LARGE/);
  });

  it('rejects archives with too many entries', () => {
    const many: Zippable = {};
    for (let i = 0; i < 30; i++) many[`f${i}.json`] = strToU8('{}');
    const z = zipSync(many);
    expect(code(() => safeUnzip(z, { maxEntries: 10 }))).toBe('TOO_LARGE');
    expect(safeUnzip(z, { maxEntries: 30 }).size).toBe(30);
    const lots: Zippable = {};
    for (let i = 0; i < 5001; i++) lots[`f${i}`] = new Uint8Array(0);
    expect(code(() => safeUnzip(zipSync(lots)))).toBe('TOO_LARGE');
  });

  it('rejects corrupted data and non-zip input', () => {
    const z = zipSync({ 'a.json': strToU8('{"hello":"world"}') }, { level: 0 });
    const corrupt = z.slice();
    const idx = Buffer.from(corrupt).indexOf('hello');
    corrupt[idx] = 'j'.charCodeAt(0);
    expect(code(() => safeUnzip(corrupt))).toBe('UNTRUSTED');
    expect(code(() => safeUnzip(strToU8('not a zip at all')))).not.toBe('no-error');
    expect(crc32(strToU8('123456789'))).toBe(0xcbf43926);
  });
});
