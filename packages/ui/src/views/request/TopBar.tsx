import { HTTP_METHODS } from '@reqvyn/core';
import { useEffect, useState } from 'react';
import { VarInput } from '../../components/VarInput';
import { Icon, IconButton } from '../../components/ui';
import { methodClass } from '../../lib/methods';
import {
  cancelRequest,
  copyAsCurl,
  patchRequest,
  requestCodegen,
  saveRequest,
  selectEnvironment,
  sendRequest,
  setUrl,
  useRequestStore,
} from './store';

export function TopBar() {
  return (
    <header className="rv-topbar">
      <Breadcrumb />
      <UrlRow />
    </header>
  );
}

function Breadcrumb() {
  const context = useRequestStore((s) => s.context);
  const name = useRequestStore((s) => s.request?.name ?? '');
  const dirty = useRequestStore((s) => s.dirty);
  const environments = useRequestStore((s) => s.environments);
  const activeEnv = useRequestStore((s) => s.activeEnvironmentId);
  const env = environments.find((e) => e.id === activeEnv);
  return (
    <div className="rv-crumbs">
      <nav aria-label="Location" className="rv-crumbs__path">
        {context?.scratch ? (
          <span className="rv-crumb rv-muted">
            <Icon name="note" /> Scratch request
          </span>
        ) : (
          <>
            {context?.collectionName && (
              <span className="rv-crumb">
                <Icon name="library" /> {context.collectionName}
              </span>
            )}
            {context?.path.map((p, i) => (
              <span className="rv-crumb" key={`${p}-${i}`}>
                <Icon name="chevron-right" className="rv-crumb__sep" />
                <Icon name="folder" /> {p}
              </span>
            ))}
            {context?.collectionName && <Icon name="chevron-right" className="rv-crumb__sep" />}
          </>
        )}
        <input className="rv-crumbs__name" value={name} aria-label="Request name" spellCheck={false} onChange={(e) => patchRequest({ name: e.target.value })} />
        {dirty && (
          <span className="rv-dirty" title="Unsaved changes" role="status" aria-label="Unsaved changes">
            ●
          </span>
        )}
      </nav>
      <div className="rv-env-select">
        {env?.color && <span className="rv-env-dot" style={{ background: env.color }} aria-hidden="true" />}
        <Icon name="server-environment" />
        <select aria-label="Active environment" value={activeEnv ?? ''} onChange={(e) => selectEnvironment(e.target.value || null)} className="rv-select">
          <option value="">No environment</option>
          {environments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

const CUSTOM = '__custom__';

function MethodSelect() {
  const method = useRequestStore((s) => s.request?.method ?? 'GET');
  const standard = (HTTP_METHODS as readonly string[]).includes(method);
  const [custom, setCustom] = useState(!standard);
  useEffect(() => {
    if (!standard) setCustom(true);
  }, [standard]);
  return (
    <div className={`rv-method ${methodClass(method)}`}>
      <select
        className="rv-method__select"
        aria-label="HTTP method"
        value={custom ? CUSTOM : method}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          patchRequest({ method: e.target.value });
        }}
      >
        {HTTP_METHODS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {custom && (
        <input
          className="rv-method__custom"
          aria-label="Custom HTTP method"
          placeholder="METHOD"
          value={method}
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
            patchRequest({ method: v || 'GET' });
          }}
        />
      )}
    </div>
  );
}

function UrlRow() {
  const url = useRequestStore((s) => s.request?.url ?? '');
  const loading = useRequestStore((s) => s.response.status === 'loading');
  return (
    <div className="rv-urlrow">
      <MethodSelect />
      <VarInput className="rv-url" value={url} onChange={setUrl} onEnter={sendRequest} ariaLabel="Request URL" placeholder="https://api.example.com/resource or {{baseUrl}}/path" />
      {loading ? (
        <button type="button" className="rv-send rv-send--cancel" onClick={cancelRequest} title="Cancel (Esc)">
          <Icon name="debug-stop" /> Cancel
        </button>
      ) : (
        <button type="button" className="rv-send" onClick={sendRequest} title="Send (Ctrl/Cmd+Enter)">
          <Icon name="send" /> Send
        </button>
      )}
      <div className="rv-urlrow__actions">
        <IconButton icon="save" label="Save (Ctrl/Cmd+S)" onClick={() => saveRequest(false)} />
        <IconButton icon="save-as" label="Save as… (Ctrl/Cmd+Shift+S)" onClick={() => saveRequest(true)} />
        <IconButton icon="code" label="Generate code" onClick={() => requestCodegen()} />
        <IconButton icon="terminal" label="Copy as cURL" onClick={copyAsCurl} />
      </div>
    </div>
  );
}
