import { parseCollection, type Collection, type Environment, type Folder, type HttpRequest, type KeyValue } from '@reqvyn/core';
import { deepClone, newId } from '@reqvyn/shared';
import { importOpenApi, operationKey, type OpenApiImportOptions } from './importers/openapi.js';
import type { ImportWarning } from './types.js';
import { importError, nowIso } from './util.js';

/**
 * Refresh a collection that was imported from OpenAPI with a newer version of the spec.
 * Operations are matched by `meta.openapi` method + path (falling back to operationId when a path
 * was renamed). User edits (headers, tests, scripts, auth, body, name) are preserved; only the
 * spec-owned parts (URL, newly added parameters, docs, metadata) are updated.
 */

export interface RefreshAdded {
  key: string;
  method: string;
  path: string;
  name: string;
  /** Folder (tag) name the operation will be placed in, if any. */
  folder?: string;
  request: HttpRequest;
}

export interface RefreshChanged {
  key: string;
  requestId: string;
  name: string;
  /** Human readable list of differences, e.g. "query parameter +expand". */
  changes: string[];
  request: HttpRequest;
}

export interface RefreshRef {
  key: string;
  requestId: string;
  name: string;
}

export interface OpenApiRefreshPlan {
  added: RefreshAdded[];
  removed: RefreshRef[];
  changed: RefreshChanged[];
  unchanged: RefreshRef[];
  /** Plain-text summary suitable for a confirmation dialog. */
  preview: string;
  /** The freshly imported spec (used to apply the plan). */
  imported: Collection;
  environments: Environment[];
  warnings: ImportWarning[];
  specHash?: string;
}

export interface ApplyRefreshOptions {
  /** Delete requests whose operation disappeared from the spec (default false: they are kept and reported). */
  removeMissing?: boolean;
  /** Also update request names from operation summaries (default false: user names are kept). */
  updateNames?: boolean;
}

export interface ApplyRefreshResult {
  collection: Collection;
  added: string[];
  updated: string[];
  removed: string[];
  /** Operations missing from the spec that were kept because `removeMissing` was not set. */
  kept: string[];
}

function keyOf(r: HttpRequest): string | undefined {
  const o = r.meta.openapi;
  return o ? operationKey(o.method, o.path) : undefined;
}

function diffKeyValues(label: string, before: KeyValue[], after: KeyValue[]): string[] {
  const b = new Set(before.map((x) => x.key.toLowerCase()));
  const a = new Set(after.map((x) => x.key.toLowerCase()));
  const out: string[] = [];
  for (const x of after) if (!b.has(x.key.toLowerCase())) out.push(`${label} +${x.key}`);
  for (const x of before) if (!a.has(x.key.toLowerCase())) out.push(`${label} -${x.key}`);
  return out;
}

function describeChanges(existing: HttpRequest, next: HttpRequest): string[] {
  const out: string[] = [];
  if (existing.meta.openapi?.path !== next.meta.openapi?.path) out.push(`path ${existing.meta.openapi?.path ?? '?'} -> ${next.meta.openapi?.path ?? '?'}`);
  out.push(...diffKeyValues('query parameter', existing.params, next.params));
  out.push(...diffKeyValues('header', existing.headers, next.headers));
  out.push(...diffKeyValues('path parameter', existing.variables, next.variables));
  out.push(...diffKeyValues('cookie', existing.cookies, next.cookies));
  if (existing.body.mode !== next.body.mode) out.push(`body ${existing.body.mode} -> ${next.body.mode}`);
  if (existing.docs !== next.docs) out.push('documentation/schemas');
  if (!out.length) out.push('operation definition');
  return out;
}

/** Compare an existing collection with a (new version of an) OpenAPI spec. Does not modify anything. */
export function planOpenApiRefresh(existing: Collection, spec: unknown, opts: OpenApiImportOptions = {}): OpenApiRefreshPlan {
  const imported = importOpenApi(spec, opts);
  const fresh = imported.collections[0];
  if (!fresh) throw importError('The OpenAPI document produced no collection.');
  const byKey = new Map<string, HttpRequest>();
  const byOpId = new Map<string, HttpRequest>();
  for (const r of existing.requests) {
    const k = keyOf(r);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, r);
    const opId = r.meta.openapi?.operationId;
    if (opId && !byOpId.has(opId)) byOpId.set(opId, r);
  }
  const folderName = (r: HttpRequest) => (r.parentId ? fresh.folders.find((f) => f.id === r.parentId)?.name : undefined);
  const matched = new Set<string>();
  const plan: OpenApiRefreshPlan = { added: [], removed: [], changed: [], unchanged: [], preview: '', imported: fresh, environments: imported.environments, warnings: imported.warnings, specHash: fresh.meta.source?.hash };
  for (const r of fresh.requests) {
    const o = r.meta.openapi;
    if (!o) continue;
    const key = operationKey(o.method, o.path);
    let match = byKey.get(key);
    if ((!match || matched.has(match.id)) && o.operationId) {
      const alt = byOpId.get(o.operationId);
      if (alt && !matched.has(alt.id) && alt.meta.openapi?.method.toUpperCase() === o.method.toUpperCase() && !fresh.requests.some((x) => x !== r && x.meta.openapi && keyOf(alt) === keyOf(x))) match = alt;
    }
    if (!match || matched.has(match.id)) {
      const folder = folderName(r);
      plan.added.push({ key, method: o.method, path: o.path, name: r.name, ...(folder ? { folder } : {}), request: r });
      continue;
    }
    matched.add(match.id);
    if (match.meta.openapi?.hash && match.meta.openapi.hash === o.hash && keyOf(match) === key) plan.unchanged.push({ key, requestId: match.id, name: match.name });
    else plan.changed.push({ key, requestId: match.id, name: match.name, changes: describeChanges(match, r), request: r });
  }
  for (const r of existing.requests) {
    const k = keyOf(r);
    if (k && !matched.has(r.id)) plan.removed.push({ key: k, requestId: r.id, name: r.name });
  }
  const lines = [`OpenAPI refresh: ${plan.added.length} added, ${plan.changed.length} changed, ${plan.removed.length} removed, ${plan.unchanged.length} unchanged`];
  for (const a of plan.added) lines.push(`+ ${a.key}  ${a.name}${a.folder ? `  [${a.folder}]` : ''}`);
  for (const c of plan.changed) lines.push(`~ ${c.key}  ${c.name}  (${c.changes.join(', ')})`);
  for (const r of plan.removed) lines.push(`- ${r.key}  ${r.name}  (no longer in the spec)`);
  plan.preview = lines.join('\n');
  return plan;
}

/** Merge spec-owned key/values into user-edited ones: existing entries (and their values) win; new ones are appended. */
function mergeKeyValues(user: KeyValue[], spec: KeyValue[]): KeyValue[] {
  const have = new Set(user.map((x) => x.key.toLowerCase()));
  return [...user, ...spec.filter((x) => !have.has(x.key.toLowerCase())).map((x) => ({ ...x, id: newId() }))];
}

function nextSortKey(c: Collection, parentId: string | null): number {
  const keys = [...c.folders, ...c.requests].filter((x) => x.parentId === parentId).map((x) => x.sortKey);
  return keys.length ? Math.max(...keys) + 1 : 0;
}

/** Apply a refresh plan. Returns a new collection; the input is not modified. */
export function applyOpenApiRefresh(existingIn: Collection, plan: OpenApiRefreshPlan, opts: ApplyRefreshOptions = {}): ApplyRefreshResult {
  const c = deepClone(existingIn);
  const result: ApplyRefreshResult = { collection: c, added: [], updated: [], removed: [], kept: [] };
  const ts = nowIso();

  for (const ch of plan.changed) {
    const r = c.requests.find((x) => x.id === ch.requestId);
    if (!r) continue;
    const s = ch.request;
    // Spec-owned: URL path (keeps a user-customized base by only replacing the {{baseUrl}} form), docs, metadata.
    const oldPath = r.meta.openapi?.path;
    const specUrlForOld = oldPath ? `{{baseUrl}}${oldPath.replace(/\{([^}]+)\}/g, '{{$1}}')}` : undefined;
    if (!specUrlForOld || r.url === specUrlForOld) r.url = s.url;
    r.params = mergeKeyValues(r.params, s.params);
    r.headers = mergeKeyValues(r.headers, s.headers);
    r.cookies = mergeKeyValues(r.cookies, s.cookies);
    r.variables = mergeKeyValues(r.variables, s.variables);
    if (r.body.mode === 'none' && s.body.mode !== 'none') r.body = deepClone(s.body);
    r.docs = s.docs;
    if (opts.updateNames) r.name = s.name;
    r.meta = { ...r.meta, openapi: s.meta.openapi, updatedAt: ts };
    // Preserved user edits: name, auth, scripts, tests, extractions, settings, body (unless it was empty).
    result.updated.push(r.id);
  }

  // Added operations go into a folder with the same (tag) name, created when missing.
  const folderIdFor = (folderName: string | undefined): string | null => {
    if (!folderName) return null;
    const existing = c.folders.find((f) => f.parentId === null && f.name === folderName);
    if (existing) return existing.id;
    const src = plan.imported.folders.find((f) => f.name === folderName);
    const folder: Folder = { ...(src ? deepClone(src) : ({} as Folder)), id: newId(), name: folderName, parentId: null, sortKey: nextSortKey(c, null) };
    const parsed = parseCollection({ ...c, folders: [folder], requests: [] }).folders[0] as Folder;
    c.folders.push(parsed);
    return parsed.id;
  };
  for (const a of plan.added) {
    const parentId = folderIdFor(a.folder);
    const r: HttpRequest = { ...deepClone(a.request), id: newId(), parentId, sortKey: nextSortKey(c, parentId) };
    c.requests.push(r);
    result.added.push(r.id);
  }

  for (const rm of plan.removed) {
    if (opts.removeMissing) {
      const before = c.requests.length;
      c.requests = c.requests.filter((x) => x.id !== rm.requestId);
      if (c.requests.length !== before) result.removed.push(rm.requestId);
    } else if (c.requests.some((x) => x.id === rm.requestId)) result.kept.push(rm.requestId);
  }

  const src = c.meta.source;
  c.meta = { ...c.meta, updatedAt: ts, source: { ...(src ?? { type: 'openapi' }), type: 'openapi', importedAt: ts, ...(plan.specHash ? { hash: plan.specHash } : {}) } };
  result.collection = parseCollection(c);
  return result;
}
