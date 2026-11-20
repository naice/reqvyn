import {
  createCollection,
  createFolder,
  createRequest,
  kv,
  parseCollection,
  type Collection,
  type Folder,
  type HttpRequest,
  type KeyValue,
} from '@reqvyn/core';
import { ReqvynError } from '@reqvyn/shared';
import type { ImportFormat, ImportWarning, WarningCode } from './types.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = Record<string, unknown>;

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Coerce scalar values (numbers, booleans) to strings; objects become JSON. */
export function str(v: unknown, fallback = ''): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return fallback;
  }
}

export function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Collects warnings for one import run, tagged with the source format. */
export class Warnings {
  readonly list: ImportWarning[] = [];
  constructor(readonly format: ImportFormat) {}
  add(code: WarningCode, message: string, location?: string, field?: string): void {
    this.list.push({ format: this.format, code, message, ...(location ? { location } : {}), ...(field ? { field } : {}) });
  }
  /** Report every key of `obj` that is not in `known` as unsupported. */
  unknownKeys(obj: JsonObject, known: Iterable<string>, location: string, prefix = ''): void {
    const set = new Set(known);
    for (const [k, v] of Object.entries(obj)) {
      if (set.has(k) || v === undefined || v === null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (isObject(v) && Object.keys(v).length === 0) continue;
      this.add('unsupported-field', `Field "${prefix}${k}" is not supported and was not imported.`, location, `${prefix}${k}`);
    }
  }
}

/**
 * Incrementally builds a valid collection: assigns parentId/sortKey and validates the result with
 * the core parser, so every importer produces data that passes `parseCollection`.
 */
export class CollectionBuilder {
  readonly collection: Collection;
  private readonly counters = new Map<string | null, number>();

  constructor(partial: Partial<Collection> = {}) {
    this.collection = createCollection(partial);
  }

  private nextSortKey(parentId: string | null): number {
    const n = this.counters.get(parentId) ?? 0;
    this.counters.set(parentId, n + 1);
    return n;
  }

  addFolder(partial: Partial<Folder> & { parentId: string | null }): Folder {
    const folder = createFolder({ ...partial, sortKey: partial.sortKey ?? this.nextSortKey(partial.parentId) });
    this.collection.folders.push(folder);
    return folder;
  }

  addRequest(partial: Partial<HttpRequest> & { parentId: string | null }): HttpRequest {
    const request = createRequest({ ...partial, sortKey: partial.sortKey ?? this.nextSortKey(partial.parentId) });
    this.collection.requests.push(request);
    return request;
  }

  build(): Collection {
    return parseCollection(this.collection);
  }
}

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Split a raw URL into the base (without query string) and decoded query parameters. */
export function splitUrl(raw: string): { base: string; params: KeyValue[] } {
  const trimmed = raw.trim();
  const hashIdx = trimmed.indexOf('#');
  const noHash = hashIdx >= 0 && !trimmed.slice(hashIdx).includes('}}') ? trimmed.slice(0, hashIdx) : trimmed;
  const q = noHash.indexOf('?');
  if (q < 0) return { base: noHash, params: [] };
  const base = noHash.slice(0, q);
  const params = parseQueryString(noHash.slice(q + 1));
  return { base, params };
}

export function parseQueryString(qs: string): KeyValue[] {
  const out: KeyValue[] = [];
  for (const part of qs.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = eq >= 0 ? part.slice(0, eq) : part;
    const value = eq >= 0 ? part.slice(eq + 1) : '';
    out.push(kv(safeDecode(key), safeDecode(value)));
  }
  return out;
}

const TEMPLATE_SPLIT = /(\{\{[^{}]*\}\})/g;

/** Percent-encode a query component but leave `{{variable}}` references untouched. */
export function encodeQueryComponent(s: string): string {
  return s
    .split(TEMPLATE_SPLIT)
    .map((part) => (part.startsWith('{{') && part.endsWith('}}') ? part : encodeURIComponent(part)))
    .join('');
}

/** Append enabled params to a URL (which may already contain a query string). */
export function buildUrl(url: string, params: KeyValue[], encode = true): string {
  const enabled = params.filter((p) => p.enabled && p.key);
  if (enabled.length === 0) return url;
  const enc = encode ? encodeQueryComponent : (s: string) => s;
  const qs = enabled.map((p) => (p.value === '' ? enc(p.key) : `${enc(p.key)}=${enc(p.value)}`)).join('&');
  return url + (url.includes('?') ? (url.endsWith('?') || url.endsWith('&') ? '' : '&') : '?') + qs;
}

/** Convert `:name` path segments (Postman/Insomnia style) to `{{name}}`; returns the names found. */
export function convertColonPathParams(url: string): { url: string; names: string[] } {
  const names: string[] = [];
  const converted = url.replace(/(^|\/):([A-Za-z_][\w-]*)(?=\/|$|\?|#)/g, (_m, pre: string, name: string) => {
    names.push(name);
    return `${pre}{{${name}}}`;
  });
  return { url: converted, names };
}

// ---------------------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------------------

export function importError(message: string, hint?: string, cause?: unknown): ReqvynError {
  return new ReqvynError('IMPORT', message, { ...(hint ? { hint } : {}), ...(cause !== undefined ? { cause } : {}) });
}

export function normalizeMethod(m: unknown, fallback = 'GET'): string {
  const s = str(m).trim().toUpperCase();
  return s || fallback;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Look up a header value (case-insensitive) among enabled headers. */
export function headerValue(headers: KeyValue[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.enabled && h.key.toLowerCase() === lower)?.value;
}

/** Choose a REQVYN body mode for raw text with an optional content type. */
export function bodyFromRaw(
  text: string,
  contentType: string | undefined,
): { mode: 'json'; text: string } | { mode: 'xml'; text: string } | { mode: 'text'; text: string; contentType?: string } {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json')) return { mode: 'json', text };
  if (ct.includes('xml')) return { mode: 'xml', text };
  if (ct) return { mode: 'text', text, contentType };
  return { mode: 'text', text };
}

/** Flatten nested objects into dot-separated keys (`{a:{b:1}}` -> `a.b=1`). */
export function flattenObject(obj: unknown, prefix = '', out: Array<[string, string]> = []): Array<[string, string]> {
  if (isObject(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (isObject(v)) flattenObject(v, key, out);
      else out.push([key, str(v)]);
    }
  }
  return out;
}

export function decodeText(content: string | Uint8Array): string {
  if (typeof content === 'string') return content.replace(/^\uFEFF/, '');
  return new TextDecoder('utf-8').decode(content).replace(/^\uFEFF/, '');
}
