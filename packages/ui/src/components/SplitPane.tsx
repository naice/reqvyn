import { useCallback, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

export type SplitOrientation = 'horizontal' | 'vertical';

/**
 * Two resizable panes. `horizontal` = side by side, `vertical` = stacked. The separator is
 * keyboard accessible (arrow keys, Home/End) and exposes aria-valuenow.
 */
export function SplitPane({
  orientation,
  ratio,
  onRatio,
  first,
  second,
  min = 0.15,
}: {
  orientation: SplitOrientation;
  ratio: number;
  onRatio: (r: number) => void;
  first: ReactNode;
  second: ReactNode;
  min?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const clamp = useCallback((r: number) => Math.min(1 - min, Math.max(min, r)), [min]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = root.current;
    if (!el) return;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const move = (ev: globalThis.PointerEvent) => {
      const r = orientation === 'horizontal' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      onRatio(clamp(r));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      document.body.classList.remove('rv-resizing');
    };
    document.body.classList.add('rv-resizing');
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const dec = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const inc = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === dec) onRatio(clamp(ratio - step));
    else if (e.key === inc) onRatio(clamp(ratio + step));
    else if (e.key === 'Home') onRatio(clamp(0));
    else if (e.key === 'End') onRatio(clamp(1));
    else return;
    e.preventDefault();
  };

  const pct = `${(ratio * 100).toFixed(2)}%`;
  return (
    <div ref={root} className={`rv-split rv-split--${orientation}`}>
      <div className="rv-split__pane" style={{ flexBasis: pct }}>
        {first}
      </div>
      <div
        className="rv-split__sash"
        role="separator"
        tabIndex={0}
        aria-orientation={orientation === 'horizontal' ? 'vertical' : 'horizontal'}
        aria-label="Resize request and response panes"
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round((1 - min) * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        onPointerDown={onPointerDown}
        onKeyDown={onKey}
        onDoubleClick={() => onRatio(0.5)}
      />
      <div className="rv-split__pane rv-split__pane--second">{second}</div>
    </div>
  );
}
