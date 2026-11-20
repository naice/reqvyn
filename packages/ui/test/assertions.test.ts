import { describe, expect, it } from 'vitest';
import type { Assertion, AssertionGroup } from '@reqvyn/core';
import { addNode, countAssertions, findNode, moveNode, newAssertion, newGroup, operatorsFor, removeNode, updateNode } from '../src/lib/assertions';

function tree() {
  const root = newGroup('and');
  const a = newAssertion('status');
  const b = newAssertion('json');
  const g = newGroup('or');
  const c = newAssertion('header');
  let t = addNode(root, root.id, a);
  t = addNode(t, root.id, b);
  t = addNode(t, root.id, g);
  t = addNode(t, g.id, c);
  return { t, root, a, b, g, c };
}

describe('assertion tree', () => {
  it('creates sensible defaults', () => {
    expect(newAssertion('status')).toMatchObject({ kind: 'assert', operator: 'eq', expected: '200', enabled: true });
    expect(newAssertion('json')).toMatchObject({ operator: 'exists', path: '$.' });
    expect(newGroup('or')).toMatchObject({ kind: 'group', logic: 'or', items: [] });
  });
  it('adds nested nodes immutably and counts enabled assertions', () => {
    const { t, root, g, c } = tree();
    expect(root.items).toHaveLength(0);
    expect(countAssertions(t)).toBe(3);
    expect(findNode(t, c.id)).toEqual(c);
    expect((findNode(t, g.id) as AssertionGroup).items).toHaveLength(1);
    expect(countAssertions(undefined)).toBe(0);
  });
  it('updates nodes; changing source resets incompatible operator and path', () => {
    const { t, a, c } = tree();
    const t2 = updateNode(t, a.id, { expected: '201' });
    expect((findNode(t2, a.id) as Assertion).expected).toBe('201');
    const t3 = updateNode(updateNode(t, c.id, { operator: 'exists', path: 'X-Id' }), c.id, { source: 'status' });
    const changed = findNode(t3, c.id) as Assertion;
    expect(changed.source).toBe('status');
    expect(operatorsFor('status')).toContain(changed.operator);
    expect(changed.path).toBe('');
    expect(countAssertions(updateNode(t, a.id, { enabled: false }))).toBe(2);
  });
  it('updates the root group but keeps its identity', () => {
    const { t } = tree();
    const r = updateNode(t, t.id, { logic: 'or' }) as AssertionGroup;
    expect(r.logic).toBe('or');
    expect(r.id).toBe(t.id);
  });
  it('moves and removes nodes', () => {
    const { t, a, b, c, g } = tree();
    expect(moveNode(t, b.id, -1).items.map((i) => i.id)).toEqual([b.id, a.id, g.id]);
    expect(moveNode(t, a.id, -1)).toBe(t);
    const removed = removeNode(t, c.id);
    expect(findNode(removed, c.id)).toBeUndefined();
    expect(countAssertions(removed)).toBe(2);
  });
  it('limits operators per source', () => {
    expect(operatorsFor('status')).not.toContain('contains');
    expect(operatorsFor('body')).toContain('isJson');
    expect(operatorsFor('header')).toContain('exists');
  });
});
