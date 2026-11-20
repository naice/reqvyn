import { newId } from '@reqvyn/shared';
import type { KeyValue } from '@reqvyn/core';

/**
 * URL <-> query parameter synchronisation. Values are kept raw (not decoded/encoded) so that
 * `{{variables}}` and user formatting survive round trips; the HTTP engine applies encoding.
 */

export interface SplitUrl {
  base: string;
  query: string | null;
  hash: string;
}

export function splitUrl(url: string): SplitUrl {
  let rest = url;
  let hash = '';
  const hashIdx = findOutsideVars(rest, '#');
  if (hashIdx >= 0) {
    hash = rest.slice(hashIdx);
    rest = rest.slice(0, hashIdx);
  }
  const qIdx = findOutsideVars(rest, '?');
  if (qIdx < 0) return { base: rest, query: null, hash };
  return { base: rest.slice(0, qIdx), query: rest.slice(qIdx + 1), hash };
}

/** Index of `ch` that is not inside a `{{ ... }}` reference. */
function findOutsideVars(s: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{' && s[i + 1] === '{') {
      depth++;
      i++;
    } else if (s[i] === '}' && s[i + 1] === '}' && depth > 0) {
      depth--;
      i++;
    } else if (depth === 0 && s[i] === ch) return i;
  }
  return -1;
}

export function parseQuery(query: string): Array<{ key: string; value: string }> {
  if (!query) return [];
  return query
    .split('&')
    .filter((p) => p.length > 0)
    .map((part) => {
      const eq = part.indexOf('=');
      return eq < 0 ? { key: part, value: '' } : { key: part.slice(0, eq), value: part.slice(eq + 1) };
    });
}

export function buildQuery(params: KeyValue[]): string {
  return params
    .filter((p) => p.enabled && (p.key !== '' || p.value !== ''))
    .map((p) => (p.value === '' ? p.key : `${p.key}=${p.value}`))
    .join('&');
}

/**
 * Apply a URL edit to the params table: enabled params are replaced in order by the parsed query
 * pairs (keeping ids/descriptions), disabled params are kept in place, extra pairs are appended.
 */
export function paramsFromUrl(url: string, existing: KeyValue[], makeId: () => string = newId): KeyValue[] {
  const { query } = splitUrl(url);
  const parsed = parseQuery(query ?? '');
  const out: KeyValue[] = [];
  let i = 0;
  for (const p of existing) {
    if (!p.enabled) {
      out.push(p);
      continue;
    }
    // Blank enabled rows are not represented in the URL; keep them only if nothing else claims the slot.
    if (p.key === '' && p.value === '') continue;
    const next = parsed[i++];
    if (!next) continue;
    out.push(p.key === next.key && p.value === next.value ? p : { ...p, key: next.key, value: next.value });
  }
  for (; i < parsed.length; i++) {
    const next = parsed[i]!;
    out.push({ id: makeId(), key: next.key, value: next.value, enabled: true });
  }
  return out;
}

/** Rebuild the URL query string from the params table. */
export function urlFromParams(url: string, params: KeyValue[]): string {
  const { base, hash } = splitUrl(url);
  const q = buildQuery(params);
  return q ? `${base}?${q}${hash}` : `${base}${hash}`;
}

export function paramsEqual(a: KeyValue[], b: KeyValue[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i]!;
    return p.id === q.id && p.key === q.key && p.value === q.value && p.enabled === q.enabled;
  });
}
