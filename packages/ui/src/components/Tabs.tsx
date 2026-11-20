import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabDef<T extends string> {
  id: T;
  label: string;
  badge?: ReactNode;
  title?: string;
}

/** ARIA tablist with roving tabindex and arrow/Home/End navigation (automatic activation). */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  ariaLabel,
  idPrefix,
  actions,
  className,
}: {
  tabs: ReadonlyArray<TabDef<T>>;
  active: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  idPrefix: string;
  actions?: ReactNode;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div className={`rv-tabs ${className ?? ''}`}>
      <div role="tablist" aria-label={ariaLabel} className="rv-tabs__list">
        {tabs.map((t, i) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${idPrefix}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              className={`rv-tab ${selected ? 'is-active' : ''}`}
              title={t.title}
              onClick={() => onChange(t.id)}
              onKeyDown={(e) => onKey(e, i)}
            >
              {t.label}
              {t.badge !== undefined && t.badge !== null && t.badge !== false && <span className="rv-tab__badge">{t.badge}</span>}
            </button>
          );
        })}
      </div>
      {actions && <div className="rv-tabs__actions">{actions}</div>}
    </div>
  );
}

export function TabPanel({ idPrefix, id, children, className }: { idPrefix: string; id: string; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} className={`rv-tabpanel ${className ?? ''}`} tabIndex={-1}>
      {children}
    </div>
  );
}

/** Segmented single-choice control (radio group semantics). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: ReadonlyArray<{ value: T; label: string; title?: string }>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    if (next < 0) return;
    e.preventDefault();
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="rv-segmented">
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={`rv-segmented__opt ${o.value === value ? 'is-active' : ''}`}
          title={o.title}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
