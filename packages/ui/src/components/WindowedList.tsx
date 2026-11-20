import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { computeOffsets, visibleRange } from '../lib/windowing';

/** Minimal virtualized list supporting variable (but known) item heights. */
export function WindowedList<T>({
  items,
  itemHeight,
  renderItem,
  getKey,
  ariaLabel,
  className,
  overscan = 6,
  stickToBottom,
}: {
  items: readonly T[];
  itemHeight: (item: T, index: number) => number;
  renderItem: (item: T, index: number) => ReactNode;
  getKey: (item: T, index: number) => string;
  ariaLabel: string;
  className?: string;
  overscan?: number;
  /** Auto-scroll to the end while the user is at the bottom (live results). */
  stickToBottom?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);
  const atBottom = useRef(true);

  const offsets = useMemo(() => computeOffsets(items.length, (i) => itemHeight(items[i]!, i)), [items, itemHeight]);
  const total = offsets[items.length] ?? 0;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (stickToBottom && el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [total, stickToBottom]);

  const { start, end } = visibleRange(offsets, scrollTop, viewport, overscan);
  const children: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const item = items[i]!;
    children.push(
      <div key={getKey(item, i)} role="listitem" className="rv-wlist__item" style={{ top: offsets[i], height: offsets[i + 1]! - offsets[i]! }}>
        {renderItem(item, i)}
      </div>,
    );
  }
  return (
    <div
      ref={ref}
      className={`rv-wlist ${className ?? ''}`}
      role="list"
      aria-label={ariaLabel}
      onScroll={(e) => {
        const el = e.currentTarget;
        setScrollTop(el.scrollTop);
        atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      }}
    >
      <div className="rv-wlist__spacer" style={{ height: total }}>
        {children}
      </div>
    </div>
  );
}
