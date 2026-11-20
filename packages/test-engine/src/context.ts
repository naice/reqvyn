import type { Cookie } from '@reqvyn/core';

/** The response data visible to assertions, extractions and post-response scripts. Plain JSON data only. */
export interface ResponseContext {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  bodyText: string;
  timeMs: number;
  size: number;
  cookies: Cookie[];
  contentType: string;
}

/** All values of a header (case-insensitive), in order. */
export function headerValues(headers: Array<[string, string]>, name: string): string[] {
  const lower = name.trim().toLowerCase();
  return headers.filter(([k]) => k.toLowerCase() === lower).map(([, v]) => v);
}

/** Combined header value as defined by RFC 9110 (comma-joined); undefined when absent. */
export function combinedHeader(headers: Array<[string, string]>, name: string): string | undefined {
  const vals = headerValues(headers, name);
  if (vals.length === 0) return undefined;
  return vals.join(name.trim().toLowerCase() === 'set-cookie' ? '\n' : ', ');
}

/** Find a cookie by name, falling back to parsing Set-Cookie headers. */
export function findCookie(ctx: ResponseContext, name: string): Cookie | undefined {
  const c = ctx.cookies.find((x) => x.name === name);
  if (c) return c;
  for (const raw of headerValues(ctx.headers, 'set-cookie')) {
    const first = raw.split(';')[0] ?? '';
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    if (first.slice(0, eq).trim() === name) return { name, value: first.slice(eq + 1).trim() };
  }
  return undefined;
}

export type JsonParse = { ok: true; value: unknown } | { ok: false; error: string };

const parseCache = new WeakMap<ResponseContext, JsonParse>();

/** Parse the body as JSON once per context (memoised). */
export function parseBodyJson(ctx: ResponseContext): JsonParse {
  const cached = parseCache.get(ctx);
  if (cached) return cached;
  let result: JsonParse;
  try {
    const text = ctx.bodyText.charCodeAt(0) === 0xfeff ? ctx.bodyText.slice(1) : ctx.bodyText;
    result = { ok: true, value: JSON.parse(text) };
  } catch (e) {
    result = { ok: false, error: (e as Error).message };
  }
  parseCache.set(ctx, result);
  return result;
}

export function stringifyValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export function preview(v: unknown, max = 200): string {
  const s = typeof v === 'string' ? JSON.stringify(v) : stringifyValue(v);
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}
