import { ASSERTION_SOURCES, type Assertion, type AssertionGroup, type AssertionSource } from '@reqvyn/core';
import { memo } from 'react';
import {
  OPERATOR_LABELS,
  SOURCE_LABELS,
  addNode,
  moveNode,
  needsExpected,
  needsPath,
  newAssertion,
  newGroup,
  operatorsFor,
  pathPlaceholder,
  removeNode,
  updateNode,
} from '../lib/assertions';
import { VarInput } from './VarInput';
import { Button, IconButton, Select } from './ui';

/** Graphical, scriptless test builder with nested AND/OR groups. */
export function AssertionBuilder({ root, onChange }: { root: AssertionGroup; onChange: (g: AssertionGroup) => void }) {
  const ops: Ops = {
    add: (parentId, node) => onChange(addNode(root, parentId, node)),
    update: (id, patch) => onChange(updateNode(root, id, patch)),
    remove: (id) => onChange(removeNode(root, id)),
    move: (id, d) => onChange(moveNode(root, id, d)),
  };
  return (
    <div className="rv-asserts">
      <GroupView group={root} ops={ops} isRoot />
    </div>
  );
}

interface Ops {
  add: (parentId: string, node: Assertion | AssertionGroup) => void;
  update: (id: string, patch: Partial<Assertion> | Partial<AssertionGroup>) => void;
  remove: (id: string) => void;
  move: (id: string, delta: -1 | 1) => void;
}

function GroupView({ group, ops, isRoot }: { group: AssertionGroup; ops: Ops; isRoot?: boolean }) {
  return (
    <div className={`rv-agroup ${isRoot ? 'rv-agroup--root' : ''} ${group.enabled ? '' : 'is-disabled'}`} role="group" aria-label={group.name || (isRoot ? 'Assertions' : 'Assertion group')}>
      <div className="rv-agroup__head">
        {!isRoot && <input type="checkbox" checked={group.enabled} aria-label="Enable group" title="Enable group" onChange={(e) => ops.update(group.id, { enabled: e.target.checked })} />}
        <span className="rv-muted">Pass when</span>
        <Select
          value={group.logic}
          ariaLabel="Group logic"
          options={[
            { value: 'and', label: 'ALL (AND)' },
            { value: 'or', label: 'ANY (OR)' },
          ]}
          onChange={(v) => ops.update(group.id, { logic: v })}
        />
        <span className="rv-muted">of the following match</span>
        {!isRoot && (
          <input className="rv-input rv-agroup__name" placeholder="Group name" aria-label="Group name" value={group.name ?? ''} onChange={(e) => ops.update(group.id, { name: e.target.value })} />
        )}
        <span className="rv-spacer" />
        {!isRoot && (
          <>
            <IconButton icon="arrow-up" label="Move group up" onClick={() => ops.move(group.id, -1)} />
            <IconButton icon="arrow-down" label="Move group down" onClick={() => ops.move(group.id, 1)} />
            <IconButton icon="trash" label="Delete group" onClick={() => ops.remove(group.id)} />
          </>
        )}
      </div>
      <div className="rv-agroup__items">
        {group.items.length === 0 && <div className="rv-muted rv-pad">No assertions yet. Add one to validate the response without writing code.</div>}
        {group.items.map((it) => (it.kind === 'group' ? <GroupView key={it.id} group={it} ops={ops} /> : <AssertionRow key={it.id} a={it} ops={ops} />))}
      </div>
      <div className="rv-agroup__foot">
        <Button icon="add" onClick={() => ops.add(group.id, newAssertion('status'))}>
          Assertion
        </Button>
        <Button icon="group-by-ref-type" onClick={() => ops.add(group.id, newGroup(group.logic === 'and' ? 'or' : 'and'))}>
          Group
        </Button>
        <span className="rv-muted rv-quick">Quick add:</span>
        <button type="button" className="rv-chip" onClick={() => ops.add(group.id, newAssertion('status'))}>
          Status = 200
        </button>
        <button type="button" className="rv-chip" onClick={() => ops.add(group.id, newAssertion('responseTime'))}>
          Time &lt; 1000ms
        </button>
        <button type="button" className="rv-chip" onClick={() => ops.add(group.id, { ...newAssertion('body'), operator: 'isJson' })}>
          Body is JSON
        </button>
        <button type="button" className="rv-chip" onClick={() => ops.add(group.id, newAssertion('json'))}>
          JSON property exists
        </button>
      </div>
    </div>
  );
}

const AssertionRow = memo(function AssertionRow({ a, ops }: { a: Assertion; ops: Ops }) {
  const up = (patch: Partial<Assertion>) => ops.update(a.id, patch);
  return (
    <div className={`rv-arow ${a.enabled ? '' : 'is-disabled'}`}>
      <input type="checkbox" checked={a.enabled} aria-label="Enable assertion" title="Enable assertion" onChange={(e) => up({ enabled: e.target.checked })} />
      <Select<AssertionSource> value={a.source} ariaLabel="Assertion source" options={ASSERTION_SOURCES.map((s) => ({ value: s, label: SOURCE_LABELS[s] }))} onChange={(v) => up({ source: v })} />
      {needsPath(a.source) && (
        <input className="rv-input rv-arow__path rv-mono" value={a.path} placeholder={pathPlaceholder(a.source)} aria-label="Path or name" spellCheck={false} onChange={(e) => up({ path: e.target.value })} />
      )}
      <Select value={a.operator} ariaLabel="Operator" options={operatorsFor(a.source).map((o) => ({ value: o, label: OPERATOR_LABELS[o] }))} onChange={(v) => up({ operator: v })} />
      {needsExpected(a.operator) ? (
        <VarInput
          className="rv-arow__expected"
          value={a.expected}
          ariaLabel="Expected value"
          placeholder={a.operator === 'isType' ? 'string | number | boolean | object | array | null' : a.operator === 'schema' ? 'JSON schema' : 'Expected'}
          onChange={(v) => up({ expected: v })}
        />
      ) : (
        <span className="rv-arow__expected" />
      )}
      <IconButton icon="arrow-up" label="Move up" onClick={() => ops.move(a.id, -1)} />
      <IconButton icon="arrow-down" label="Move down" onClick={() => ops.move(a.id, 1)} />
      <IconButton icon="trash" label="Delete assertion" onClick={() => ops.remove(a.id)} />
    </div>
  );
});
