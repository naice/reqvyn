import type { Extraction, WritableVariableScope } from '@reqvyn/core';
import { combinedHeader, findCookie, parseBodyJson, stringifyValue, type ResponseContext } from './context.js';
import { jsonPathQuery } from './jsonpath.js';
import { parseRegex } from './assertions.js';

export interface ExtractionResult {
  id: string;
  variable: string;
  scope: WritableVariableScope;
  value?: string;
  error?: string;
}

function extractOne(x: Extraction, ctx: ResponseContext): { value?: string; error?: string } {
  const path = (x.path ?? '').trim();
  switch (x.source) {
    case 'status':
      return { value: String(ctx.status) };
    case 'body':
      return { value: ctx.bodyText };
    case 'header': {
      if (!path) return { error: 'No header name given' };
      const v = combinedHeader(ctx.headers, path);
      return v === undefined ? { error: `Header "${path}" not found in response` } : { value: v };
    }
    case 'cookie': {
      if (!path) return { error: 'No cookie name given' };
      const c = findCookie(ctx, path);
      return c === undefined ? { error: `Cookie "${path}" not found in response` } : { value: c.value };
    }
    case 'json': {
      const parsed = parseBodyJson(ctx);
      if (!parsed.ok) return { error: `Response body is not valid JSON (${parsed.error})` };
      if (!path || path === '$') return { value: stringifyValue(parsed.value) };
      const q = jsonPathQuery(parsed.value, path);
      if (q.values.length === 0) return { error: `JSONPath ${path} matched nothing` };
      return { value: stringifyValue(q.definite ? q.values[0] : q.values) };
    }
    case 'regex': {
      if (!path) return { error: 'No regular expression given' };
      let re: RegExp;
      try {
        re = parseRegex(path);
      } catch (e) {
        return { error: `Invalid regular expression: ${(e as Error).message}` };
      }
      const m = re.exec(ctx.bodyText);
      if (!m) return { error: `Regular expression ${re.toString()} did not match the response body` };
      return { value: m.length > 1 && m[1] !== undefined ? m[1] : m[0] };
    }
  }
  return { error: `Unsupported extraction source "${String((x as { source: unknown }).source)}"` };
}

/** Run enabled extractions against a response. Never throws; failures are reported per extraction. */
export function runExtractions(extractions: Extraction[], ctx: ResponseContext): ExtractionResult[] {
  const out: ExtractionResult[] = [];
  for (const x of extractions ?? []) {
    if (!x || x.enabled === false) continue;
    const base = { id: x.id, variable: x.variable, scope: x.scope ?? 'runtime' } as const;
    if (!x.variable?.trim()) {
      out.push({ ...base, error: 'No target variable name given' });
      continue;
    }
    try {
      out.push({ ...base, ...extractOne(x, ctx) });
    } catch (e) {
      out.push({ ...base, error: (e as Error).message });
    }
  }
  return out;
}
