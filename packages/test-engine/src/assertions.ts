import type { Assertion, AssertionGroup, AssertionOperator, AssertionSource, TestResult } from '@reqvyn/core';
import { combinedHeader, findCookie, parseBodyJson, preview, stringifyValue, type ResponseContext } from './context.js';
import { jsonPathQuery } from './jsonpath.js';
import { validateJsonSchema } from './schema.js';

export interface EvaluateAssertionsOptions {
  /** Resolves `{{variables}}` in `expected` and `path` before evaluation. */
  interpolate?: (s: string) => string;
}

const OPERATOR_LABELS: Record<AssertionOperator, string> = {
  eq: 'equals',
  neq: 'does not equal',
  lt: 'is less than',
  lte: 'is less than or equal to',
  gt: 'is greater than',
  gte: 'is greater than or equal to',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  exists: 'exists',
  notExists: 'does not exist',
  matches: 'matches',
  isType: 'is of type',
  isJson: 'is valid JSON',
  arrayContains: 'contains item',
  lengthEq: 'has length',
  schema: 'matches JSON schema',
};

const NO_EXPECTED = new Set<AssertionOperator>(['exists', 'notExists', 'isJson', 'schema']);
const NUMERIC_SOURCES = new Set<AssertionSource>(['status', 'responseTime', 'size']);

export function sourceLabel(source: AssertionSource, path: string): string {
  switch (source) {
    case 'status':
      return 'Status';
    case 'responseTime':
      return 'Response time';
    case 'body':
      return 'Body';
    case 'json':
      return path ? `JSON ${path}` : 'JSON body';
    case 'header':
      return `Header ${path || '(unnamed)'}`;
    case 'contentType':
      return 'Content-Type';
    case 'size':
      return 'Response size';
    case 'cookie':
      return `Cookie ${path || '(unnamed)'}`;
  }
}

function unit(source: AssertionSource): string {
  return source === 'responseTime' ? ' ms' : source === 'size' ? ' bytes' : '';
}

/** Human-readable default name, e.g. "Status equals 200". */
export function assertionName(a: Pick<Assertion, 'source' | 'path' | 'operator' | 'expected' | 'description'>): string {
  if (a.description?.trim()) return a.description.trim();
  const base = `${sourceLabel(a.source, a.path)} ${OPERATOR_LABELS[a.operator] ?? a.operator}`;
  if (NO_EXPECTED.has(a.operator)) return base;
  const exp = a.expected.length > 60 ? `${a.expected.slice(0, 57)}...` : a.expected;
  return `${base} ${exp}${NUMERIC_SOURCES.has(a.source) && /^-?\d/.test(exp) ? unit(a.source) : ''}`;
}

interface Actual {
  present: boolean;
  value: unknown;
  error?: string;
}

function resolveActual(source: AssertionSource, path: string, ctx: ResponseContext, operator: AssertionOperator): Actual {
  switch (source) {
    case 'status':
      return { present: true, value: ctx.status };
    case 'responseTime':
      return { present: true, value: ctx.timeMs };
    case 'size':
      return { present: true, value: ctx.size };
    case 'contentType':
      return { present: ctx.contentType !== '', value: ctx.contentType };
    case 'body':
      return { present: ctx.bodyText !== '', value: ctx.bodyText };
    case 'header': {
      if (!path) return { present: false, value: undefined, error: 'No header name given' };
      const v = combinedHeader(ctx.headers, path);
      return { present: v !== undefined, value: v };
    }
    case 'cookie': {
      if (!path) return { present: false, value: undefined, error: 'No cookie name given' };
      const c = findCookie(ctx, path);
      return { present: c !== undefined, value: c?.value };
    }
    case 'json': {
      const parsed = parseBodyJson(ctx);
      if (!parsed.ok) {
        if (operator === 'isJson') return { present: true, value: ctx.bodyText };
        return { present: false, value: undefined, error: `Response body is not valid JSON (${parsed.error})` };
      }
      if (!path.trim() || path.trim() === '$') return { present: true, value: parsed.value };
      try {
        const q = jsonPathQuery(parsed.value, path.trim());
        if (q.definite) return { present: q.values.length > 0, value: q.values[0] };
        return { present: q.values.length > 0, value: q.values };
      } catch (e) {
        return { present: false, value: undefined, error: (e as Error).message };
      }
    }
  }
}

/** Interpret the textual `expected` value against an actual value of some type. */
function looseEquals(actual: unknown, expected: string): boolean {
  if (typeof actual === 'string') {
    if (actual === expected) return true;
    // allow JSON-quoted expectation: "abc"
    if (expected.length >= 2 && expected.startsWith('"') && expected.endsWith('"')) {
      try {
        return JSON.parse(expected) === actual;
      } catch {
        return false;
      }
    }
    return false;
  }
  if (typeof actual === 'number') {
    const t = expected.trim();
    return t !== '' && Number(t) === actual;
  }
  if (typeof actual === 'boolean') return expected.trim() === String(actual);
  if (actual === null) return expected.trim() === 'null';
  if (actual === undefined) return expected.trim() === 'undefined' || expected.trim() === '';
  try {
    return deepEqual(actual, JSON.parse(expected));
  } catch {
    return stringifyValue(actual) === expected;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function parseRegex(text: string): RegExp {
  const m = /^\/(.*)\/([dgimsuvy]*)$/s.exec(text);
  if (m) return new RegExp(m[1]!, m[2]!.replace('g', ''));
  return new RegExp(text);
}

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

type Outcome = { passed: boolean; message?: string };

function check(a: Assertion, actual: Actual, ctx: ResponseContext, expected: string): Outcome {
  const label = sourceLabel(a.source, a.path);
  const got = actual.present ? preview(actual.value) : '(missing)';
  const u = unit(a.source);
  const fail = (what: string): Outcome => ({ passed: false, message: `Expected ${label} ${what}, but got ${got}` });

  if (actual.error) return { passed: false, message: actual.error };

  switch (a.operator) {
    case 'exists':
      return actual.present ? { passed: true } : { passed: false, message: `Expected ${label} to exist, but it was not found` };
    case 'notExists':
      return !actual.present ? { passed: true } : { passed: false, message: `Expected ${label} not to exist, but found ${got}` };
    case 'eq':
      return actual.present && looseEquals(actual.value, expected) ? { passed: true } : fail(`to equal ${preview(expected)}`);
    case 'neq':
      return !(actual.present && looseEquals(actual.value, expected)) ? { passed: true } : fail(`not to equal ${preview(expected)}`);
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const x = toNumber(actual.value);
      const y = toNumber(expected);
      if (y === undefined) return { passed: false, message: `Expected value "${expected}" is not a number` };
      if (x === undefined) return { passed: false, message: `${label} is not numeric (got ${got})` };
      const ok = a.operator === 'lt' ? x < y : a.operator === 'lte' ? x <= y : a.operator === 'gt' ? x > y : x >= y;
      return ok
        ? { passed: true }
        : { passed: false, message: `Expected ${label} ${OPERATOR_LABELS[a.operator]} ${y}${u}, but got ${x}${u}` };
    }
    case 'contains':
    case 'notContains': {
      let has: boolean;
      if (!actual.present) has = false;
      else if (Array.isArray(actual.value)) has = actual.value.some((x) => looseEquals(x, expected));
      else if (typeof actual.value === 'object' && actual.value !== null)
        has = Object.prototype.hasOwnProperty.call(actual.value, expected) || stringifyValue(actual.value).includes(expected);
      else has = stringifyValue(actual.value).includes(expected);
      if (a.operator === 'contains') return has ? { passed: true } : fail(`to contain ${preview(expected)}`);
      if (!actual.present) return { passed: true };
      return !has ? { passed: true } : fail(`not to contain ${preview(expected)}`);
    }
    case 'startsWith':
      return actual.present && stringifyValue(actual.value).startsWith(expected) ? { passed: true } : fail(`to start with ${preview(expected)}`);
    case 'endsWith':
      return actual.present && stringifyValue(actual.value).endsWith(expected) ? { passed: true } : fail(`to end with ${preview(expected)}`);
    case 'matches': {
      let re: RegExp;
      try {
        re = parseRegex(expected);
      } catch (e) {
        return { passed: false, message: `Invalid regular expression ${preview(expected)}: ${(e as Error).message}` };
      }
      return actual.present && re.test(stringifyValue(actual.value)) ? { passed: true } : fail(`to match ${re.toString()}`);
    }
    case 'isType': {
      const want = expected.trim().toLowerCase();
      const valid = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'undefined'];
      if (!valid.includes(want)) return { passed: false, message: `Unknown type "${expected}" (use one of ${valid.join(', ')})` };
      const t = actual.present ? jsonType(actual.value) : 'undefined';
      const ok = want === 'integer' ? Number.isInteger(actual.value) : t === want;
      return ok ? { passed: true } : { passed: false, message: `Expected ${label} to be of type ${want}, but got ${t} (${got})` };
    }
    case 'isJson': {
      const text = a.source === 'json' || a.source === 'body' ? ctx.bodyText : stringifyValue(actual.value);
      try {
        JSON.parse(text);
        return { passed: true };
      } catch (e) {
        return { passed: false, message: `Expected ${a.source === 'json' || a.source === 'body' ? 'response body' : label} to be valid JSON: ${(e as Error).message}` };
      }
    }
    case 'arrayContains': {
      if (!Array.isArray(actual.value)) return { passed: false, message: `Expected ${label} to be an array, but got ${got}` };
      return actual.value.some((x) => looseEquals(x, expected)) ? { passed: true } : fail(`to contain item ${preview(expected)}`);
    }
    case 'lengthEq': {
      const n = toNumber(expected);
      if (n === undefined) return { passed: false, message: `Expected length "${expected}" is not a number` };
      const v = actual.value;
      const len = Array.isArray(v) || typeof v === 'string' ? v.length : typeof v === 'object' && v !== null ? Object.keys(v).length : undefined;
      if (len === undefined) return { passed: false, message: `${label} has no length (got ${got})` };
      return len === n ? { passed: true } : { passed: false, message: `Expected ${label} to have length ${n}, but it has length ${len}` };
    }
    case 'schema': {
      let schema: unknown;
      try {
        schema = JSON.parse(expected);
      } catch (e) {
        return { passed: false, message: `JSON schema is not valid JSON: ${(e as Error).message}` };
      }
      let data = actual.value;
      if (a.source === 'body') {
        const parsed = parseBodyJson(ctx);
        if (!parsed.ok) return { passed: false, message: `Response body is not valid JSON (${parsed.error})` };
        data = parsed.value;
      }
      if (!actual.present && a.source === 'json') return { passed: false, message: `${label} was not found` };
      const r = validateJsonSchema(schema, data);
      return r.valid ? { passed: true } : { passed: false, message: `${label} does not match the schema:\n- ${r.errors.join('\n- ')}` };
    }
  }
  return { passed: false, message: `Unsupported operator "${String(a.operator)}"` };
}

function evaluateAssertion(a: Assertion, ctx: ResponseContext, opts: EvaluateAssertionsOptions): TestResult {
  const interp = (s: string) => {
    if (!opts.interpolate) return s;
    try {
      return opts.interpolate(s);
    } catch {
      return s;
    }
  };
  const path = interp(a.path ?? '');
  const expected = interp(a.expected ?? '');
  const resolved: Assertion = { ...a, path, expected };
  const name = assertionName(resolved);
  try {
    const actual = resolveActual(a.source, path, ctx, a.operator);
    const outcome = check(resolved, actual, ctx, expected);
    return { id: a.id, name, passed: outcome.passed, message: outcome.message, source: 'assertion' };
  } catch (e) {
    return { id: a.id, name, passed: false, message: `Assertion could not be evaluated: ${(e as Error).message}`, source: 'assertion' };
  }
}

function isGroup(x: Assertion | AssertionGroup): x is AssertionGroup {
  return x.kind === 'group';
}

function evaluateGroup(g: AssertionGroup, ctx: ResponseContext, opts: EvaluateAssertionsOptions, depth: number): TestResult {
  const children = depth > 50 ? [] : evaluateItems(g.items, ctx, opts, depth + 1);
  const logic = g.logic === 'or' ? 'or' : 'and';
  const passed =
    children.length === 0 ? true : logic === 'and' ? children.every((c) => c.passed) : children.some((c) => c.passed);
  const name = g.name?.trim() || (logic === 'and' ? `All of ${children.length} assertions` : `Any of ${children.length} assertions`);
  let message: string | undefined;
  if (!passed) {
    const failed = children.filter((c) => !c.passed).length;
    message =
      logic === 'and'
        ? `${failed} of ${children.length} assertions failed (all must pass)`
        : `None of the ${children.length} assertions passed (at least one must pass)`;
  }
  return { id: g.id, name, passed, message, source: 'assertion', children };
}

function evaluateItems(items: Array<Assertion | AssertionGroup>, ctx: ResponseContext, opts: EvaluateAssertionsOptions, depth: number): TestResult[] {
  const out: TestResult[] = [];
  for (const item of items ?? []) {
    if (!item || item.enabled === false) continue;
    out.push(isGroup(item) ? evaluateGroup(item, ctx, opts, depth) : evaluateAssertion(item, ctx, opts));
  }
  return out;
}

/**
 * Evaluate a (nested) assertion group. When the root group uses AND logic its enabled items are returned
 * as individual results (nested groups appear as results with `children`). When the root uses OR logic a
 * single combined result is returned. A disabled root yields no results. Never throws.
 */
export function evaluateAssertions(group: AssertionGroup, ctx: ResponseContext, opts: EvaluateAssertionsOptions = {}): TestResult[] {
  if (!group || group.enabled === false) return [];
  if (group.logic === 'or') {
    const r = evaluateGroup(group, ctx, opts, 0);
    return r.children && r.children.length > 0 ? [r] : [];
  }
  return evaluateItems(group.items, ctx, opts, 0);
}
