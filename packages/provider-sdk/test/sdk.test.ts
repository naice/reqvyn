import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SyncProviderError,
  canonicalJson,
  computeSnapshotRevision,
  createEntity,
  emptySnapshot,
  hashJson,
  isRetryable,
  isReqvynExtensionApi,
  isSyncProviderError,
  manifestFromSnapshot,
  sha256Hex,
  toSyncProviderError,
  validateConfigValues,
  validateDescriptor,
  validateSnapshot,
  withRetry,
  type SyncProviderDescriptor,
} from '../src/index.js';

const nodeSha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

describe('hashing', () => {
  it('matches node:crypto for many inputs', () => {
    const inputs = ['', 'abc', 'ü€😀', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(1000)];
    for (const s of inputs) expect(sha256Hex(s)).toBe(nodeSha(s));
    const bytes = new Uint8Array(300).map((_, i) => (i * 7) & 255);
    expect(sha256Hex(bytes)).toBe(nodeSha(bytes));
  });

  it('hashes canonical JSON (key order and undefined do not matter)', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
    expect(hashJson({ a: 1 })).toBe(nodeSha('{"a":1}'));
  });
});

describe('snapshots', () => {
  const snap = () => {
    const s = emptySnapshot('c');
    s.entities.c = createEntity('collection', { id: 'c', name: 'C' });
    s.entities.r = createEntity('request', { id: 'r', name: 'R' });
    return s;
  };

  it('computes content revisions independent of metadata', () => {
    const a = snap();
    const b = { ...snap(), revision: 'whatever', updatedAt: '2020-01-01T00:00:00Z', label: 'x' };
    expect(computeSnapshotRevision(a)).toBe(computeSnapshotRevision(b));
    b.entities.r = createEntity('request', { id: 'r', name: 'changed' });
    expect(computeSnapshotRevision(a)).not.toBe(computeSnapshotRevision(b));
    const m = manifestFromSnapshot(a, 'rev');
    expect(m.entities.r).toEqual({ kind: 'request', hash: a.entities.r!.hash });
  });

  it('validates structure and hashes', () => {
    expect(validateSnapshot(snap()).collectionId).toBe('c');
    const bad = snap();
    bad.entities.r!.hash = '0'.repeat(64);
    expect(() => validateSnapshot(bad)).toThrow(SyncProviderError);
    expect(() => validateSnapshot({ ...snap(), formatVersion: 99 })).toThrow(/format/i);
    expect(() => validateSnapshot(snap(), { collectionId: 'other' })).toThrow();
    expect(() => validateSnapshot({ nope: true })).toThrow();
    try {
      validateSnapshot(bad);
    } catch (e) {
      expect(isSyncProviderError(e) && e.code).toBe('INVALID_DATA');
    }
  });
});

describe('errors and retry', () => {
  it('classifies retryability', () => {
    expect(isRetryable(new SyncProviderError('NETWORK', 'x'))).toBe(true);
    expect(isRetryable(new SyncProviderError('AUTH', 'x'))).toBe(false);
    expect(isRetryable(new SyncProviderError('INTERNAL', 'x', { retryable: true }))).toBe(true);
    expect(toSyncProviderError(Object.assign(new Error('x'), { code: 'ECONNRESET' }), 'f').code).toBe('NETWORK');
    expect(toSyncProviderError(Object.assign(new Error('x'), { code: 'EACCES' }), 'f').code).toBe('PERMISSION');
    expect(toSyncProviderError(new DOMException('aborted', 'AbortError'), 'f').code).toBe('CANCELLED');
    expect(toSyncProviderError('weird', 'fallback').code).toBe('INTERNAL');
  });

  it('retries retryable errors and honours cancellation', async () => {
    let n = 0;
    const v = await withRetry(
      async () => {
        if (++n < 3) throw new SyncProviderError('UNAVAILABLE', 'busy');
        return 'ok';
      },
      { baseDelayMs: 1 },
    );
    expect(v).toBe('ok');
    let m = 0;
    await expect(withRetry(async () => { m++; throw new SyncProviderError('AUTH', 'no'); }, { baseDelayMs: 1 })).rejects.toMatchObject({ code: 'AUTH' });
    expect(m).toBe(1);
    const ac = new AbortController();
    ac.abort();
    await expect(withRetry(async () => 1, { signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('descriptor and config validation', () => {
  const descriptor: SyncProviderDescriptor = {
    id: 'acme.rest',
    displayName: 'Acme',
    capabilities: { read: true, write: true, optimisticConcurrency: true, list: false, delete: false, auth: false },
    configSchema: [
      { key: 'baseUrl', label: 'URL', type: 'url', required: true },
      { key: 'timeout', label: 'Timeout', type: 'number', default: 5 },
      { key: 'token', label: 'Token', type: 'secret', required: true },
    ],
  };

  it('accepts a valid descriptor and rejects bad ones', () => {
    expect(validateDescriptor(descriptor)).toEqual([]);
    expect(validateDescriptor({ ...descriptor, id: 'Bad Id' }).length).toBeGreaterThan(0);
    expect(validateDescriptor({ ...descriptor, configSchema: [descriptor.configSchema[0], descriptor.configSchema[0]] }).length).toBeGreaterThan(0);
    expect(validateDescriptor({ ...descriptor, configSchema: [{ key: 's', label: 's', type: 'secret', default: 'leak' }] }).length).toBeGreaterThan(0);
  });

  it('validates values, applies defaults and keeps secrets out of config', () => {
    const ok = validateConfigValues(descriptor.configSchema, { baseUrl: 'https://x.test' }, new Set(['token']));
    expect(ok.issues).toEqual([]);
    expect(ok.values.timeout).toBe(5);
    expect(validateConfigValues(descriptor.configSchema, { baseUrl: 'ftp://x' }, new Set(['token'])).issues.length).toBeGreaterThan(0);
    expect(validateConfigValues(descriptor.configSchema, { baseUrl: 'https://x.test' }, new Set<string>()).issues.length).toBeGreaterThan(0);
    expect(validateConfigValues(descriptor.configSchema, { baseUrl: 'https://x.test', token: 'inline' }, new Set(['token'])).issues.length).toBeGreaterThan(0);
  });

  it('recognizes the extension API shape', () => {
    expect(isReqvynExtensionApi({ apiVersion: 1, registerSyncProvider: () => ({ dispose() {} }) })).toBe(true);
    expect(isReqvynExtensionApi({ apiVersion: 2, registerSyncProvider: () => undefined })).toBe(false);
    expect(isReqvynExtensionApi(undefined)).toBe(false);
  });
});
