import type { KeyValue } from '@reqvyn/core';
import { useEffect, useState } from 'react';
import { KeyValueTable } from '../../components/KeyValueTable';
import { VarInput } from '../../components/VarInput';
import { Button, EmptyState, Icon, IconButton } from '../../components/ui';
import { editEnvironment, saveEnvironment, setSecretValue, setVariables, toggleSecret, useEnvironmentStore } from './store';

export function EnvironmentView() {
  const env = useEnvironmentStore((s) => s.environment);
  const isGlobal = useEnvironmentStore((s) => s.isGlobal);
  const dirty = useEnvironmentStore((s) => s.dirty);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveEnvironment();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!env) return <EmptyState icon="loading" title="Loading environment…" />;
  const secretCount = env.variables.filter((v) => v.secret).length;

  return (
    <div className="rv-view rv-envview">
      <header className="rv-topbar">
        <Icon name={isGlobal ? 'globe' : 'symbol-namespace'} />
        {isGlobal ? (
          <span className="rv-topbar__title">Global variables</span>
        ) : (
          <input className="rv-input rv-topbar__name" value={env.name} aria-label="Environment name" onChange={(e) => editEnvironment({ name: e.target.value })} />
        )}
        {!isGlobal && (
          <input
            type="color"
            className="rv-color"
            aria-label="Environment colour"
            title="Environment colour"
            value={env.color && /^#[0-9a-f]{6}$/i.test(env.color) ? env.color : '#00e5ff'}
            onChange={(e) => editEnvironment({ color: e.target.value })}
          />
        )}
        {dirty && (<span className="rv-dirty" title="Unsaved changes" role="status" aria-label="Unsaved changes">●</span>)}
        <span className="rv-spacer" />
        <Button primary icon="save" onClick={saveEnvironment} disabled={!dirty}>
          Save
        </Button>
      </header>
      <div className="rv-scroll rv-grow rv-pad">
        <KeyValueTable
          rows={env.variables}
          onChange={setVariables}
          ariaLabel={isGlobal ? 'Global variables' : `Variables of ${env.name}`}
          keyPlaceholder="Variable"
          description
          bulk
          filter={filter}
          toolbar={
            <input
              type="search"
              className="rv-input rv-input--search"
              placeholder="Search variables"
              aria-label="Search variables"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          }
          renderValue={(row, up, ghost) => (row.secret && !ghost ? <SecretCell row={row} /> : <VarInput value={row.value} onChange={(value) => up({ value })} placeholder="Value" ariaLabel={`Value of ${row.key || 'new variable'}`} className="rv-cell-var" />)}
          extraHeader="Secret"
          renderExtra={(row, _up, ghost) =>
            ghost ? null : (
              <input
                type="checkbox"
                checked={!!row.secret}
                aria-label={`Store ${row.key || 'variable'} as secret`}
                title={row.secret ? 'Secret: value lives in VS Code SecretStorage' : 'Mark as secret (value moves to SecretStorage and is never written to files)'}
                disabled={!row.key}
                onChange={(e) => toggleSecret(row, e.target.checked)}
              />
            )
          }
        />
        <p className="rv-hint">
          {secretCount > 0 ? `${secretCount} secret value${secretCount === 1 ? ' is' : 's are'} kept in SecretStorage and never shown. ` : ''}
          Reference variables with <code>{'{{name}}'}</code>. In bulk edit, secrets appear as <code>********</code>; replace the placeholder to set a new value.
        </p>
      </div>
    </div>
  );
}

function SecretCell({ row }: { row: KeyValue }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  if (!editing) {
    return (
      <div className="rv-hstack rv-secret-cell">
        <span className="rv-mono rv-muted" aria-label="Secret value hidden">
          ••••••••
        </span>
        <IconButton icon="edit" label={`Set new value for ${row.key}`} onClick={() => setEditing(true)} />
      </div>
    );
  }
  const commit = () => {
    if (value) setSecretValue(row.key, value);
    setValue('');
    setEditing(false);
  };
  return (
    <form
      className="rv-hstack rv-secret-cell"
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
    >
      <input
        className="rv-cell-input"
        type="password"
        autoFocus
        autoComplete="off"
        value={value}
        aria-label={`New secret value for ${row.key}`}
        placeholder="New secret value"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setValue('');
            setEditing(false);
          }
        }}
      />
      <IconButton icon="check" label="Store secret" onClick={commit} />
      <IconButton
        icon="close"
        label="Cancel"
        onClick={() => {
          setValue('');
          setEditing(false);
        }}
      />
    </form>
  );
}
