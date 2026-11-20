import { describe, expect, it } from 'vitest';
import type { Assertion, AssertionGroup, AssertionOperator, AssertionSource } from '@reqvyn/core';
import { evaluateAssertions, type ResponseContext } from '../src/index.js';

const body = {
  id: 42,
  name: 'Ada',
  active: true,
  nothing: null,
  tags: ['admin', 'dev'],
  items: [{ id: 1 }, { id: 2 }],
  score: 9.5,
};

function ctx(overrides: Partial<ResponseContext> = {}): ResponseContext {
  return {
    status: 200,
    statusText: 'OK',
    headers: [
      ['Content-Type', 'application/json; charset=utf-8'],
      ['X-Request-Id', 'abc-123'],
      ['Set-Cookie', 'other=1; Path=/'],
    ],
    bodyText: JSON.stringify(body),
    timeMs: 120,
    size: 512,
    cookies: [{ name: 'session', value: 's3cr3t-session' }],
    contentType: 'application/json; charset=utf-8',
    ...overrides,
  };
}

let seq = 0;
function a(source: AssertionSource, operator: AssertionOperator, expected = '', path = '', extra: Partial<Assertion> = {}): Assertion {
  return { id: `a${++seq}`, kind: 'assert', enabled: true, source, operator, expected, path, ...extra };
}
function group(items: AssertionGroup['items'], logic: 'and' | 'or' = 'and', extra: Partial<AssertionGroup> = {}): AssertionGroup {
  return { id: `g${++seq}`, kind: 'group', enabled: true, logic, items, ...extra };
}
function one(x: Assertion, c: ResponseContext = ctx()) {
  const r = evaluateAssertions(group([x]), c);
  expect(r).toHaveLength(1);
  return r[0]!;
}

type Case = [AssertionSource, AssertionOperator, string, string, boolean];

// [source, operator, path, expected, shouldPass]
const cases: Case[] = [
  // status
  ['status', 'eq', '', '200', true],
  ['status', 'eq', '', '201', false],
  ['status', 'neq', '', '404', true],
  ['status', 'neq', '', '200', false],
  ['status', 'lt', '', '300', true],
  ['status', 'lt', '', '200', false],
  ['status', 'lte', '', '200', true],
  ['status', 'lte', '', '199', false],
  ['status', 'gt', '', '199', true],
  ['status', 'gt', '', '200', false],
  ['status', 'gte', '', '200', true],
  ['status', 'gte', '', '201', false],
  ['status', 'contains', '', '20', true],
  ['status', 'notContains', '', '4', true],
  ['status', 'startsWith', '', '2', true],
  ['status', 'endsWith', '', '1', false],
  ['status', 'exists', '', '', true],
  ['status', 'notExists', '', '', false],
  ['status', 'matches', '', '^2\\d\\d$', true],
  ['status', 'matches', '', '/^4/', false],
  ['status', 'isType', '', 'integer', true],
  ['status', 'isType', '', 'string', false],
  ['status', 'isJson', '', '', true],
  ['status', 'lengthEq', '', '3', false],
  ['status', 'arrayContains', '', '200', false],
  // responseTime
  ['responseTime', 'lt', '', '500', true],
  ['responseTime', 'lt', '', '100', false],
  ['responseTime', 'gte', '', '120', true],
  ['responseTime', 'eq', '', '120', true],
  ['responseTime', 'isType', '', 'number', true],
  // size
  ['size', 'lte', '', '1024', true],
  ['size', 'gt', '', '1024', false],
  ['size', 'eq', '', '512', true],
  // body
  ['body', 'contains', '', '"name":"Ada"', true],
  ['body', 'contains', '', 'Grace', false],
  ['body', 'notContains', '', 'Grace', true],
  ['body', 'notContains', '', 'Ada', false],
  ['body', 'startsWith', '', '{', true],
  ['body', 'endsWith', '', '}', true],
  ['body', 'endsWith', '', ']', false],
  ['body', 'matches', '', '"id":\\s*42', true],
  ['body', 'matches', '', '/ADA/i', true],
  ['body', 'matches', '', 'zzz', false],
  ['body', 'exists', '', '', true],
  ['body', 'isJson', '', '', true],
  ['body', 'isType', '', 'string', true],
  ['body', 'eq', '', JSON.stringify(body), true],
  ['body', 'neq', '', 'x', true],
  ['body', 'lengthEq', '', String(JSON.stringify(body).length), true],
  ['body', 'schema', '', '{"type":"object","required":["id"]}', true],
  ['body', 'schema', '', '{"type":"object","required":["missing"]}', false],
  // json
  ['json', 'eq', '$.id', '42', true],
  ['json', 'eq', 'id', '43', false],
  ['json', 'eq', '$.name', 'Ada', true],
  ['json', 'eq', '$.name', '"Ada"', true],
  ['json', 'eq', '$.active', 'true', true],
  ['json', 'eq', '$.nothing', 'null', true],
  ['json', 'eq', '$.tags', '["admin","dev"]', true],
  ['json', 'eq', '$.items[0]', '{"id":1}', true],
  ['json', 'neq', '$.name', 'Grace', true],
  ['json', 'neq', '$.name', 'Ada', false],
  ['json', 'lt', '$.score', '10', true],
  ['json', 'lte', '$.score', '9.5', true],
  ['json', 'gt', '$.score', '9.5', false],
  ['json', 'gte', '$.id', '42', true],
  ['json', 'contains', '$.name', 'd', true],
  ['json', 'contains', '$.tags', 'dev', true],
  ['json', 'contains', '$.tags', 'ops', false],
  ['json', 'notContains', '$.tags', 'ops', true],
  ['json', 'startsWith', '$.name', 'A', true],
  ['json', 'endsWith', '$.name', 'x', false],
  ['json', 'exists', '$.nothing', '', true],
  ['json', 'exists', '$.missing', '', false],
  ['json', 'notExists', '$.missing', '', true],
  ['json', 'notExists', '$.id', '', false],
  ['json', 'matches', '$.name', '^A', true],
  ['json', 'isType', '$.tags', 'array', true],
  ['json', 'isType', '$.items[0]', 'object', true],
  ['json', 'isType', '$.nothing', 'null', true],
  ['json', 'isType', '$.active', 'boolean', true],
  ['json', 'isType', '$.score', 'integer', false],
  ['json', 'isType', '$.name', 'number', false],
  ['json', 'isJson', '', '', true],
  ['json', 'arrayContains', '$.tags', 'admin', true],
  ['json', 'arrayContains', '$.items[*].id', '2', true],
  ['json', 'arrayContains', '$.items', '{"id":2}', true],
  ['json', 'arrayContains', '$.items[*].id', '3', false],
  ['json', 'lengthEq', '$.items', '2', true],
  ['json', 'lengthEq', '$.name', '3', true],
  ['json', 'lengthEq', '$.tags', '3', false],
  ['json', 'schema', '$.items', '{"type":"array","items":{"type":"object","required":["id"]}}', true],
  ['json', 'schema', '', '{"type":"object","properties":{"id":{"type":"string"}}}', false],
  // header
  ['header', 'exists', 'x-request-id', '', true],
  ['header', 'exists', 'X-Missing', '', false],
  ['header', 'notExists', 'X-Missing', '', true],
  ['header', 'eq', 'X-Request-Id', 'abc-123', true],
  ['header', 'neq', 'X-Request-Id', 'abc-123', false],
  ['header', 'contains', 'content-type', 'json', true],
  ['header', 'notContains', 'content-type', 'xml', true],
  ['header', 'startsWith', 'X-Request-Id', 'abc', true],
  ['header', 'endsWith', 'X-Request-Id', '124', false],
  ['header', 'matches', 'X-Request-Id', '^[a-z]+-\\d+$', true],
  ['header', 'lengthEq', 'X-Request-Id', '7', true],
  ['header', 'isType', 'X-Request-Id', 'string', true],
  ['header', 'contains', 'X-Missing', 'a', false],
  // contentType
  ['contentType', 'contains', '', 'application/json', true],
  ['contentType', 'startsWith', '', 'text/', false],
  ['contentType', 'eq', '', 'application/json; charset=utf-8', true],
  ['contentType', 'matches', '', 'json', true],
  ['contentType', 'exists', '', '', true],
  // cookie
  ['cookie', 'exists', 'session', '', true],
  ['cookie', 'exists', 'other', '', true],
  ['cookie', 'exists', 'nope', '', false],
  ['cookie', 'notExists', 'nope', '', true],
  ['cookie', 'eq', 'session', 's3cr3t-session', true],
  ['cookie', 'eq', 'other', '1', true],
  ['cookie', 'startsWith', 'session', 's3', true],
  ['cookie', 'contains', 'session', 'zzz', false],
];

describe('evaluateAssertions – operator × source matrix', () => {
  it.each(cases)('%s %s %s %s → %s', (source, operator, path, expected, shouldPass) => {
    const r = one(a(source, operator, expected, path));
    expect(r.source).toBe('assertion');
    expect(r.passed, `${r.name}: ${r.message}`).toBe(shouldPass);
    if (!shouldPass) expect(r.message).toBeTruthy();
    else expect(r.message).toBeUndefined();
  });

  it('covers every operator and source at least once', async () => {
    const { ASSERTION_OPERATORS, ASSERTION_SOURCES } = await import('@reqvyn/core');
    for (const op of ASSERTION_OPERATORS) expect(cases.some((c) => c[1] === op), op).toBe(true);
    for (const s of ASSERTION_SOURCES) expect(cases.some((c) => c[0] === s), s).toBe(true);
  });
});

describe('evaluateAssertions – names and messages', () => {
  it('generates human readable names', () => {
    expect(one(a('status', 'eq', '200')).name).toBe('Status equals 200');
    expect(one(a('responseTime', 'lt', '500')).name).toBe('Response time is less than 500 ms');
    expect(one(a('json', 'exists', '', '$.id')).name).toBe('JSON $.id exists');
    expect(one(a('header', 'contains', 'json', 'Content-Type')).name).toBe('Header Content-Type contains json');
    expect(one(a('body', 'isJson')).name).toBe('Body is valid JSON');
    expect(one(a('status', 'eq', '200', '', { description: 'Is OK' })).name).toBe('Is OK');
  });

  it('shows actual vs expected on failure', () => {
    expect(one(a('status', 'eq', '201')).message).toBe('Expected Status to equal "201", but got 200');
    expect(one(a('responseTime', 'lt', '100')).message).toBe('Expected Response time is less than 100 ms, but got 120 ms');
    const m = one(a('json', 'eq', 'Grace', '$.name')).message!;
    expect(m).toContain('"Grace"');
    expect(m).toContain('"Ada"');
    expect(one(a('json', 'exists', '', '$.missing')).message).toMatch(/to exist, but it was not found/);
    expect(one(a('header', 'notExists', '', 'x-request-id')).message).toContain('abc-123');
    expect(one(a('json', 'lengthEq', '3', '$.tags')).message).toBe('Expected JSON $.tags to have length 3, but it has length 2');
  });

  it('reports invalid regex, JSON and schema as failures without throwing', () => {
    expect(one(a('body', 'matches', '([a-')).message).toMatch(/Invalid regular expression/);
    const notJson = ctx({ bodyText: '<html>' });
    expect(one(a('json', 'eq', '1', '$.id'), notJson).message).toMatch(/not valid JSON/);
    expect(one(a('body', 'isJson'), notJson).passed).toBe(false);
    expect(one(a('json', 'isJson'), notJson).message).toMatch(/valid JSON/);
    expect(one(a('json', 'schema', '{not json')).message).toMatch(/schema is not valid JSON/i);
    expect(one(a('json', 'eq', '1', '$.a[')).message).toMatch(/Invalid JSONPath/);
    expect(one(a('status', 'lt', 'abc')).message).toMatch(/not a number/);
    expect(one(a('json', 'gt', '1', '$.name')).message).toMatch(/not numeric/);
    expect(one(a('status', 'isType', 'weird')).message).toMatch(/Unknown type/);
    expect(one(a('header', 'exists')).message).toMatch(/No header name/);
    expect(one(a('json', 'schema', '{"required":["zzz"]}')).message).toMatch(/missing required property "zzz"/);
  });

  it('applies interpolation to expected and path', () => {
    const r = evaluateAssertions(group([a('json', 'eq', '{{expectedId}}', '$.{{field}}')]), ctx(), {
      interpolate: (s) => s.replace('{{expectedId}}', '42').replace('{{field}}', 'id'),
    });
    expect(r[0]!.passed).toBe(true);
    expect(r[0]!.name).toBe('JSON $.id equals 42');
  });
});

describe('evaluateAssertions – groups', () => {
  it('skips disabled assertions and groups', () => {
    const r = evaluateAssertions(
      group([a('status', 'eq', '500', '', { enabled: false }), a('status', 'eq', '200'), group([a('status', 'eq', '1')], 'and', { enabled: false })]),
      ctx(),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.passed).toBe(true);
    expect(evaluateAssertions(group([a('status', 'eq', '200')], 'and', { enabled: false }), ctx())).toEqual([]);
  });

  it('evaluates AND and OR groups with nesting', () => {
    const orPass = group([a('status', 'eq', '500'), a('status', 'eq', '200')], 'or', { name: 'Status is 500 or 200' });
    const orFail = group([a('status', 'eq', '500'), a('status', 'eq', '404')], 'or');
    const andFail = group([a('status', 'eq', '200'), group([a('json', 'eq', '1', '$.id'), orPass], 'or')], 'and');
    const r = evaluateAssertions(group([orPass, orFail, andFail]), ctx());
    expect(r).toHaveLength(3);
    expect(r[0]!.name).toBe('Status is 500 or 200');
    expect(r[0]!.passed).toBe(true);
    expect(r[0]!.children).toHaveLength(2);
    expect(r[1]!.passed).toBe(false);
    expect(r[1]!.message).toMatch(/None of the 2 assertions passed/);
    expect(r[1]!.name).toBe('Any of 2 assertions');
    expect(r[2]!.passed).toBe(true); // nested OR passes via orPass
    expect(r[2]!.children![1]!.children).toHaveLength(2);

    const andWithFailure = group([a('status', 'eq', '200'), a('status', 'eq', '201')], 'and');
    const r2 = evaluateAssertions(group([andWithFailure]), ctx());
    expect(r2[0]!.passed).toBe(false);
    expect(r2[0]!.message).toBe('1 of 2 assertions failed (all must pass)');
  });

  it('returns a single combined result for an OR root', () => {
    const r = evaluateAssertions(group([a('status', 'eq', '500'), a('status', 'eq', '200')], 'or'), ctx());
    expect(r).toHaveLength(1);
    expect(r[0]!.passed).toBe(true);
    expect(r[0]!.children).toHaveLength(2);
  });

  it('treats an empty group as passing', () => {
    const r = evaluateAssertions(group([group([])]), ctx());
    expect(r[0]!.passed).toBe(true);
  });
});
