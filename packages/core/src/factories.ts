import { newId } from '@reqvyn/shared';
import {
  SCHEMA_VERSION,
  type Assertion,
  type AssertionGroup,
  type Collection,
  type Environment,
  type Folder,
  type HttpRequest,
  type KeyValue,
} from './models.js';

export function nowIso(): string {
  return new Date().toISOString();
}

export function emptyGroup(): AssertionGroup {
  return { id: newId(), kind: 'group', enabled: true, logic: 'and', items: [] };
}

export function kv(key: string, value = '', extra: Partial<KeyValue> = {}): KeyValue {
  return { id: newId(), key, value, enabled: true, ...extra };
}

export function createAssertion(partial: Partial<Assertion> & Pick<Assertion, 'source' | 'operator'>): Assertion {
  return { id: newId(), kind: 'assert', enabled: true, path: '', expected: '', ...partial };
}

export function createRequest(partial: Partial<HttpRequest> = {}): HttpRequest {
  const ts = nowIso();
  return {
    id: newId(),
    name: 'New Request',
    parentId: null,
    sortKey: 0,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'inherit' },
    cookies: [],
    scripts: { pre: '', post: '' },
    tests: emptyGroup(),
    extractions: [],
    variables: [],
    settings: {},
    docs: '',
    ...partial,
    meta: { createdAt: ts, updatedAt: ts, ...(partial.meta ?? {}) },
  };
}

export function createFolder(partial: Partial<Folder> = {}): Folder {
  const ts = nowIso();
  return {
    id: newId(),
    name: 'New Folder',
    parentId: null,
    sortKey: 0,
    description: '',
    variables: [],
    headers: [],
    auth: { type: 'inherit' },
    scripts: { pre: '', post: '' },
    tests: emptyGroup(),
    settings: {},
    ...partial,
    meta: { createdAt: ts, updatedAt: ts, ...(partial.meta ?? {}) },
  };
}

export function createCollection(partial: Partial<Collection> = {}): Collection {
  const ts = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId(),
    name: 'New Collection',
    description: '',
    variables: [],
    headers: [],
    auth: { type: 'none' },
    scripts: { pre: '', post: '' },
    tests: emptyGroup(),
    settings: {},
    runner: { iterations: 1, delayMs: 0, concurrency: 1, stopOnFailure: false },
    folders: [],
    requests: [],
    ...partial,
    meta: { createdAt: ts, updatedAt: ts, ...(partial.meta ?? {}) },
  };
}

export function createEnvironment(partial: Partial<Environment> = {}): Environment {
  return { schemaVersion: SCHEMA_VERSION, id: newId(), name: 'New Environment', variables: [], ...partial };
}
