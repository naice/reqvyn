import { useId, useState, type ReactNode } from 'react';

export function Icon({ name, className }: { name: string; className?: string }) {
  return <span className={`codicon codicon-${name} ${className ?? ''}`} aria-hidden="true" />;
}

export interface IconButtonProps {
  icon: string;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  className?: string;
  /** Visible text next to the icon (the label is always used for aria-label / tooltip). */
  text?: string;
}

export function IconButton({ icon, label, onClick, disabled, active, className, text }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`rv-iconbtn ${text ? 'has-text' : ''} ${active ? 'is-active' : ''} ${className ?? ''}`}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
      {text && <span>{text}</span>}
    </button>
  );
}

export function Button({
  children,
  onClick,
  primary,
  disabled,
  title,
  className,
  icon,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
  icon?: string;
}) {
  return (
    <button
      type="button"
      className={`rv-btn ${primary ? 'rv-btn--primary' : 'rv-btn--secondary'} ${className ?? ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

export function Checkbox({ checked, onChange, label, hideLabel, title }: { checked: boolean; onChange: (v: boolean) => void; label: string; hideLabel?: boolean; title?: string }) {
  return (
    <label className="rv-check" title={title ?? (hideLabel ? label : undefined)}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={hideLabel ? label : undefined} />
      {!hideLabel && <span>{label}</span>}
    </label>
  );
}

export function Field({ label, children, hint, inline }: { label: string; children: (id: string) => ReactNode; hint?: ReactNode; inline?: boolean }) {
  const id = useId();
  return (
    <div className={`rv-field ${inline ? 'rv-field--inline' : ''}`}>
      <label htmlFor={id} className="rv-field__label">
        {label}
      </label>
      <div className="rv-field__control">{children(id)}</div>
      {hint && <div className="rv-field__hint">{hint}</div>}
    </div>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  className,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  ariaLabel?: string;
  id?: string;
  className?: string;
}) {
  return (
    <select id={id} className={`rv-select ${className ?? ''}`} value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function EmptyState({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="rv-empty" role="status">
      <Icon name={icon} className="rv-empty__icon" />
      <div className="rv-empty__title">{title}</div>
      {children && <div className="rv-empty__body">{children}</div>}
    </div>
  );
}

export function Notice({ kind, children, icon }: { kind: 'info' | 'warning' | 'error'; children: ReactNode; icon?: string }) {
  return (
    <div className={`rv-notice rv-notice--${kind}`} role={kind === 'error' ? 'alert' : 'note'}>
      <Icon name={icon ?? (kind === 'info' ? 'info' : kind === 'warning' ? 'warning' : 'error')} />
      <div className="rv-notice__body">{children}</div>
    </div>
  );
}

export function Section({ title, children, actions, collapsible, defaultOpen = true }: { title: string; children: ReactNode; actions?: ReactNode; collapsible?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className="rv-section">
      <div className="rv-section__head">
        {collapsible ? (
          <button type="button" className="rv-section__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} />
            <h3>{title}</h3>
          </button>
        ) : (
          <h3>{title}</h3>
        )}
        <div className="rv-section__actions">{actions}</div>
      </div>
      {open && (
        <div className="rv-section__body" id={id}>
          {children}
        </div>
      )}
    </section>
  );
}

/** Password-style input with reveal toggle and optional "store as secret" action. */
export function SecretInput({
  value,
  onChange,
  ariaLabel,
  placeholder,
  onStoreSecret,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  placeholder?: string;
  onStoreSecret?: (value: string) => void;
  id?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const isRef = /^\s*\{\{\s*\$secret:[^}]+\}\}\s*$/.test(value) || /^\s*\{\{[^}]+\}\}\s*$/.test(value);
  return (
    <div className="rv-secret">
      <input
        id={id}
        className="rv-input"
        type={revealed || isRef ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {!isRef && <IconButton icon={revealed ? 'eye-closed' : 'eye'} label={revealed ? 'Hide value' : 'Reveal value'} onClick={() => setRevealed(!revealed)} />}
      {onStoreSecret && !isRef && value !== '' && (
        <IconButton icon="lock" label="Store as secret (moves the value to VS Code SecretStorage)" onClick={() => onStoreSecret(value)} />
      )}
      {isRef && <span className="rv-secret__ref" title="Value is a variable / secret reference"><Icon name="lock" /></span>}
    </div>
  );
}

export function Badge({ children, kind }: { children: ReactNode; kind?: 'default' | 'success' | 'error' | 'warning' }) {
  return <span className={`rv-badge rv-badge--${kind ?? 'default'}`}>{children}</span>;
}
