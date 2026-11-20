import { memo, useEffect, useId, useState, type ReactNode } from 'react';
import type { KeyValue } from '@reqvyn/core';
import { newId } from '@reqvyn/shared';
import { VarInput } from './VarInput';
import { IconButton } from './ui';
import { parseBulk, toBulk } from '../lib/bulk';

export interface KeyValueTableProps {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  ariaLabel: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  keySuggestions?: readonly string[];
  description?: boolean;
  /** Allow switching to KEY=VALUE bulk text mode. */
  bulk?: boolean;
  /** Use plain inputs instead of variable-aware editors for values. */
  plainValues?: boolean;
  /** Custom value cell (e.g. secret handling). */
  renderValue?: (row: KeyValue, update: (patch: Partial<KeyValue>) => void, isGhost: boolean) => ReactNode;
  /** Extra cells after the value (e.g. a secret toggle). */
  renderExtra?: (row: KeyValue, update: (patch: Partial<KeyValue>) => void, isGhost: boolean) => ReactNode;
  extraHeader?: string;
  filter?: string;
  toolbar?: ReactNode;
  emptyHint?: string;
}

export function KeyValueTable(props: KeyValueTableProps) {
  const { rows, onChange } = props;
  const [ghostId, setGhostId] = useState(newId);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [undo, setUndo] = useState<{ row: KeyValue; index: number } | null>(null);
  const listId = useId();

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(t);
  }, [undo]);

  const update = (id: string, patch: Partial<KeyValue>) => {
    if (id === ghostId) {
      onChange([...rows, { id: ghostId, key: '', value: '', enabled: true, ...patch }]);
      setGhostId(newId());
      return;
    }
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const remove = (id: string) => {
    const index = rows.findIndex((r) => r.id === id);
    if (index < 0) return;
    setUndo({ row: rows[index]!, index });
    onChange(rows.filter((r) => r.id !== id));
  };
  const restore = () => {
    if (!undo) return;
    const next = rows.slice();
    next.splice(Math.min(undo.index, next.length), 0, undo.row);
    onChange(next);
    setUndo(null);
  };

  const enterBulk = () => {
    setBulkText(toBulk(rows));
    setBulkMode(true);
  };

  const f = props.filter?.trim().toLowerCase();
  const visible = f ? rows.filter((r) => r.key.toLowerCase().includes(f) || (!r.secret && r.value.toLowerCase().includes(f))) : rows;
  const ghost: KeyValue = { id: ghostId, key: '', value: '', enabled: true };
  const allEnabled = rows.length > 0 && rows.every((r) => r.enabled);

  return (
    <div className="rv-kv">
      <div className="rv-kv__toolbar">
        {props.toolbar}
        <span className="rv-spacer" />
        {undo && (
          <button type="button" className="rv-link" onClick={restore}>
            Undo delete “{undo.row.key || 'row'}”
          </button>
        )}
        {props.bulk && (
          <IconButton
            icon={bulkMode ? 'list-flat' : 'edit'}
            text={bulkMode ? 'Table' : 'Bulk edit'}
            label={bulkMode ? 'Switch to table editor' : 'Switch to bulk edit (KEY=VALUE per line, // disables)'}
            onClick={() => (bulkMode ? setBulkMode(false) : enterBulk())}
          />
        )}
      </div>
      {bulkMode ? (
        <textarea
          className="rv-textarea rv-kv__bulk"
          aria-label={`${props.ariaLabel} (bulk edit)`}
          value={bulkText}
          spellCheck={false}
          placeholder={'KEY=value\n//DISABLED_KEY=value\n# comment'}
          onChange={(e) => {
            setBulkText(e.target.value);
            onChange(parseBulk(e.target.value, rows));
          }}
        />
      ) : (
        <table className="rv-table" aria-label={props.ariaLabel}>
          <thead>
            <tr>
              <th className="rv-table__check">
                <input
                  type="checkbox"
                  aria-label="Toggle all rows"
                  title="Toggle all"
                  checked={allEnabled}
                  disabled={rows.length === 0}
                  onChange={(e) => onChange(rows.map((r) => ({ ...r, enabled: e.target.checked })))}
                />
              </th>
              <th>Key</th>
              <th>Value</th>
              {props.description && <th>Description</th>}
              {props.renderExtra && <th className="rv-table__extra">{props.extraHeader ?? ''}</th>}
              <th className="rv-table__actions">
                <span className="rv-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <Row key={r.id} row={r} props={props} listId={listId} onUpdate={update} onRemove={remove} />
            ))}
            {!f && <Row key={ghostId} row={ghost} ghost props={props} listId={listId} onUpdate={update} onRemove={remove} />}
          </tbody>
        </table>
      )}
      {props.keySuggestions && (
        <datalist id={listId}>
          {props.keySuggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      {f && visible.length === 0 && <div className="rv-muted rv-pad">No entries match “{props.filter}”.</div>}
    </div>
  );
}

const Row = memo(function Row({
  row,
  ghost,
  props,
  listId,
  onUpdate,
  onRemove,
}: {
  row: KeyValue;
  ghost?: boolean;
  props: KeyValueTableProps;
  listId: string;
  onUpdate: (id: string, patch: Partial<KeyValue>) => void;
  onRemove: (id: string) => void;
}) {
  const up = (patch: Partial<KeyValue>) => onUpdate(row.id, patch);
  return (
    <tr className={`${!row.enabled ? 'is-disabled' : ''} ${ghost ? 'is-ghost' : ''}`}>
      <td className="rv-table__check">
        {!ghost && <input type="checkbox" checked={row.enabled} aria-label={`Enable ${row.key || 'row'}`} onChange={(e) => up({ enabled: e.target.checked })} />}
      </td>
      <td>
        <input
          className="rv-cell-input"
          value={row.key}
          placeholder={props.keyPlaceholder ?? 'Key'}
          aria-label="Key"
          spellCheck={false}
          list={props.keySuggestions ? listId : undefined}
          onChange={(e) => up({ key: e.target.value })}
        />
      </td>
      <td>
        {props.renderValue ? (
          props.renderValue(row, up, !!ghost)
        ) : props.plainValues ? (
          <input className="rv-cell-input" value={row.value} placeholder={props.valuePlaceholder ?? 'Value'} aria-label={`Value of ${row.key || 'new row'}`} spellCheck={false} onChange={(e) => up({ value: e.target.value })} />
        ) : (
          <VarInput value={row.value} onChange={(value) => up({ value })} placeholder={props.valuePlaceholder ?? 'Value'} ariaLabel={`Value of ${row.key || 'new row'}`} className="rv-cell-var" />
        )}
      </td>
      {props.description && (
        <td>
          <input className="rv-cell-input" value={row.description ?? ''} placeholder="Description" aria-label="Description" onChange={(e) => up({ description: e.target.value })} />
        </td>
      )}
      {props.renderExtra && <td className="rv-table__extra">{props.renderExtra(row, up, !!ghost)}</td>}
      <td className="rv-table__actions">{!ghost && <IconButton icon="trash" label={`Delete ${row.key || 'row'}`} onClick={() => onRemove(row.id)} />}</td>
    </tr>
  );
});

/** Read-only table of inherited entries (e.g. headers from collection/folder). */
export function InheritedTable({ rows, ariaLabel }: { rows: ReadonlyArray<{ key: string; value: string; source: string }>; ariaLabel: string }) {
  if (!rows.length) return null;
  return (
    <table className="rv-table rv-table--readonly" aria-label={ariaLabel}>
      <thead>
        <tr>
          <th>Key</th>
          <th>Value</th>
          <th>Inherited from</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.key}-${i}`}>
            <td className="rv-mono">{r.key}</td>
            <td className="rv-mono rv-break">{r.value}</td>
            <td className="rv-muted">{r.source}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
