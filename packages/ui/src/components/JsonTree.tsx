import { memo, useState } from 'react';
import { childCount, childPath, copyableValue, jsonChildren, jsonKind, previewValue } from '../lib/jsonTree';
import { copyToClipboard } from '../host';
import { IconButton } from './ui';

const PAGE = 200;

/** Lazily rendered JSON inspector: children are only materialised when a node is expanded. */
export function JsonTree({ value }: { value: unknown }) {
  return (
    <div className="rv-jtree" role="tree" aria-label="JSON tree">
      <JsonNode name="$" value={value} path="$" depth={0} defaultOpen />
    </div>
  );
}

const JsonNode = memo(function JsonNode({ name, value, path, depth, defaultOpen }: { name: string | number; value: unknown; path: string; depth: number; defaultOpen?: boolean }) {
  const kind = jsonKind(value);
  const container = kind === 'object' || kind === 'array';
  const count = container ? childCount(value) : 0;
  const [open, setOpen] = useState(!!defaultOpen || (depth < 1 && count < 50));
  const [limit, setLimit] = useState(PAGE);

  const label = typeof name === 'number' ? `[${name}]` : depth === 0 ? '' : name;
  const toggle = () => container && setOpen(!open);
  return (
    <div role="treeitem" aria-expanded={container ? open : undefined} aria-level={depth + 1} className="rv-jnode">
      <div
        className="rv-jnode__row"
        style={{ paddingLeft: depth * 14 }}
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          } else if (e.key === 'ArrowRight' && container && !open) setOpen(true);
          else if (e.key === 'ArrowLeft' && container && open) setOpen(false);
        }}
      >
        <span className={`codicon codicon-${container ? (open ? 'chevron-down' : 'chevron-right') : 'blank'} rv-jnode__twisty`} aria-hidden="true" />
        {label !== '' && <span className="rv-jnode__key">{label}</span>}
        {label !== '' && <span className="rv-jnode__colon">:</span>}
        <span className={`rv-jnode__val rv-jval--${kind}`}>{container && open ? (kind === 'array' ? `[${count}]` : `{${count}}`) : previewValue(value, 200)}</span>
        <span className="rv-jnode__actions" onClick={(e) => e.stopPropagation()}>
          <IconButton icon="symbol-field" label={`Copy path ${path}`} onClick={() => copyToClipboard(path)} />
          <IconButton icon="copy" label="Copy value" onClick={() => copyToClipboard(copyableValue(value))} />
        </span>
      </div>
      {container && open && (
        <div role="group">
          {jsonChildren(value, 0, limit).map((c) => (
            <JsonNode key={String(c.key)} name={c.key} value={c.value} path={childPath(path, c.key)} depth={depth + 1} />
          ))}
          {count > limit && (
            <button type="button" className="rv-link rv-jnode__more" style={{ marginLeft: (depth + 1) * 14 + 18 }} onClick={() => setLimit(limit + PAGE)}>
              Show {Math.min(PAGE, count - limit)} more of {count - limit} remaining…
            </button>
          )}
        </div>
      )}
    </div>
  );
});
