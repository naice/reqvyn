import { newId } from '@reqvyn/shared';
import type { Assertion, AssertionGroup, AssertionOperator, AssertionSource } from '@reqvyn/core';

export type AssertionNode = Assertion | AssertionGroup;

export const SOURCE_LABELS: Record<AssertionSource, string> = {
  status: 'Status code',
  responseTime: 'Response time (ms)',
  body: 'Body text',
  json: 'JSON value',
  header: 'Header',
  contentType: 'Content-Type',
  size: 'Body size (bytes)',
  cookie: 'Cookie',
};

export const OPERATOR_LABELS: Record<AssertionOperator, string> = {
  eq: 'equals',
  neq: 'not equals',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  exists: 'exists',
  notExists: 'does not exist',
  matches: 'matches regex',
  isType: 'is type',
  isJson: 'is valid JSON',
  arrayContains: 'array contains',
  lengthEq: 'length equals',
  schema: 'matches JSON schema',
};

const NUMERIC: AssertionOperator[] = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'];
const TEXT: AssertionOperator[] = ['eq', 'neq', 'contains', 'notContains', 'startsWith', 'endsWith', 'matches'];

/** Operators that make sense for a given source (the engine accepts all; this keeps the UI focused). */
export function operatorsFor(source: AssertionSource): AssertionOperator[] {
  switch (source) {
    case 'status':
    case 'responseTime':
    case 'size':
      return NUMERIC;
    case 'body':
      return [...TEXT, 'isJson', 'schema', 'lengthEq'];
    case 'json':
      return [...NUMERIC, 'contains', 'notContains', 'startsWith', 'endsWith', 'matches', 'exists', 'notExists', 'isType', 'arrayContains', 'lengthEq', 'schema'];
    case 'header':
    case 'cookie':
      return [...TEXT, 'exists', 'notExists'];
    case 'contentType':
      return TEXT;
  }
}

export function defaultOperator(source: AssertionSource): AssertionOperator {
  if (source === 'json') return 'exists';
  if (source === 'header' || source === 'cookie') return 'exists';
  if (source === 'responseTime') return 'lt';
  if (source === 'contentType' || source === 'body') return 'contains';
  return 'eq';
}

export function needsPath(source: AssertionSource): boolean {
  return source === 'json' || source === 'header' || source === 'cookie';
}

export function needsExpected(op: AssertionOperator): boolean {
  return op !== 'exists' && op !== 'notExists' && op !== 'isJson';
}

export function pathPlaceholder(source: AssertionSource): string {
  if (source === 'json') return '$.data.id';
  if (source === 'header') return 'Header name';
  if (source === 'cookie') return 'Cookie name';
  return '';
}

export function newAssertion(source: AssertionSource = 'status'): Assertion {
  return {
    id: newId(),
    kind: 'assert',
    enabled: true,
    source,
    path: source === 'json' ? '$.' : '',
    operator: defaultOperator(source),
    expected: source === 'status' ? '200' : source === 'responseTime' ? '1000' : '',
  };
}

export function newGroup(logic: 'and' | 'or' = 'and'): AssertionGroup {
  return { id: newId(), kind: 'group', enabled: true, logic, items: [] };
}

/** Immutable map over every group in the tree (including the root). */
function mapGroups(g: AssertionGroup, fn: (g: AssertionGroup) => AssertionGroup): AssertionGroup {
  const items = g.items.map((it) => (it.kind === 'group' ? mapGroups(it, fn) : it));
  const changed = items.some((it, i) => it !== g.items[i]);
  return fn(changed ? { ...g, items } : g);
}

export function addNode(root: AssertionGroup, parentId: string, node: AssertionNode): AssertionGroup {
  return mapGroups(root, (g) => (g.id === parentId ? { ...g, items: [...g.items, node] } : g));
}

export function updateNode(root: AssertionGroup, id: string, patch: Partial<Assertion> | Partial<AssertionGroup>): AssertionGroup {
  if (root.id === id) return { ...root, ...(patch as Partial<AssertionGroup>), kind: 'group', id: root.id };
  return mapGroups(root, (g) => {
    const idx = g.items.findIndex((it) => it.id === id);
    if (idx < 0) return g;
    const items = g.items.slice();
    const cur = items[idx]!;
    let next = { ...cur, ...patch, id: cur.id, kind: cur.kind } as AssertionNode;
    if (next.kind === 'assert' && cur.kind === 'assert' && 'source' in patch && patch.source && patch.source !== cur.source) {
      // Changing the source resets operator/path to sensible values for the new source.
      const ops = operatorsFor(patch.source);
      next = { ...next, operator: ops.includes(next.operator) ? next.operator : defaultOperator(patch.source), path: needsPath(patch.source) ? next.path : '' };
    }
    items[idx] = next;
    return { ...g, items };
  });
}

export function removeNode(root: AssertionGroup, id: string): AssertionGroup {
  return mapGroups(root, (g) => (g.items.some((it) => it.id === id) ? { ...g, items: g.items.filter((it) => it.id !== id) } : g));
}

export function moveNode(root: AssertionGroup, id: string, delta: -1 | 1): AssertionGroup {
  return mapGroups(root, (g) => {
    const idx = g.items.findIndex((it) => it.id === id);
    const to = idx + delta;
    if (idx < 0 || to < 0 || to >= g.items.length) return g;
    const items = g.items.slice();
    [items[idx], items[to]] = [items[to]!, items[idx]!];
    return { ...g, items };
  });
}

export function findNode(root: AssertionGroup, id: string): AssertionNode | undefined {
  if (root.id === id) return root;
  for (const it of root.items) {
    if (it.id === id) return it;
    if (it.kind === 'group') {
      const f = findNode(it, id);
      if (f) return f;
    }
  }
  return undefined;
}

export function countAssertions(root: AssertionGroup | undefined): number {
  if (!root) return 0;
  return root.items.reduce((n, it) => n + (it.kind === 'group' ? countAssertions(it) : it.enabled ? 1 : 0), 0);
}

/** Human readable one-line description of an assertion. */
export function describeAssertion(a: Assertion): string {
  const subject = needsPath(a.source) ? `${SOURCE_LABELS[a.source]} ${a.path}` : SOURCE_LABELS[a.source];
  return needsExpected(a.operator) ? `${subject} ${OPERATOR_LABELS[a.operator]} ${a.expected}` : `${subject} ${OPERATOR_LABELS[a.operator]}`;
}
