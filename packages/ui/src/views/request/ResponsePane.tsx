import type { ExecutionResult } from '@reqvyn/core';
import { formatBytes, formatDuration } from '@reqvyn/shared';
import { useEffect, useState } from 'react';
import { TabPanel, Tabs, type TabDef } from '../../components/Tabs';
import { Button, EmptyState, Icon, IconButton } from '../../components/ui';
import { statusClass } from '../../lib/format';
import { mimeOf } from '../../lib/language';
import { countTests } from '../../lib/timings';
import { useApp } from '../../app';
import { ResponseBody } from './ResponseBody';
import { CookiesView, HeadersView, RawView, TestResultsView, TimelineView } from './ResponseDetails';
import { cancelRequest, setResponseTab, useRequestStore, type ResponseTab } from './store';

const P = 'res';

export function ResponsePane({ orientation, onToggleOrientation }: { orientation: 'horizontal' | 'vertical'; onToggleOrientation: () => void }) {
  const response = useRequestStore((s) => s.response);
  const tab = useRequestStore((s) => s.responseTab);
  const iconUri = useApp((s) => s.iconUri);
  const result = response.result;
  const res = result?.response;

  const layoutBtn = (
    <IconButton
      icon={orientation === 'horizontal' ? 'split-vertical' : 'split-horizontal'}
      label={orientation === 'horizontal' ? 'Stack response below request' : 'Show response beside request'}
      onClick={onToggleOrientation}
    />
  );

  if (response.status === 'loading') {
    return (
      <div className="rv-pane rv-respane">
        <div className="rv-respane__meta">
          <span className="rv-spacer" />
          {layoutBtn}
        </div>
        <Loading startedAt={response.startedAt ?? Date.now()} />
      </div>
    );
  }

  if (!result) {
    return (
      <div className="rv-pane rv-respane">
        <div className="rv-respane__meta">
          <span className="rv-spacer" />
          {layoutBtn}
        </div>
        {response.status === 'cancelled' ? (
          <EmptyState icon="circle-slash" title="Request cancelled" />
        ) : (
          <div className="rv-empty" role="status">
            {iconUri ? <img src={iconUri} alt="" className="rv-empty__logo" /> : <Icon name="send" className="rv-empty__icon" />}
            <div className="rv-empty__title">Send a request to see the response</div>
            <div className="rv-empty__body">
              <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd> to send · <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>S</kbd> to save
            </div>
            <div className="rv-tagline">Send. Inspect. Repeat.</div>
          </div>
        )}
      </div>
    );
  }

  const tests = countTests(result.tests);
  const tabs: Array<TabDef<ResponseTab>> = [
    { id: 'body', label: 'Body' },
    { id: 'headers', label: 'Headers', badge: res ? res.headers.length : undefined },
    { id: 'cookies', label: 'Cookies', badge: res?.cookies.length || undefined },
    {
      id: 'tests',
      label: 'Test Results',
      badge: tests.passed + tests.failed > 0 ? <span className={tests.failed ? 'rv-fail' : 'rv-pass'}>{`${tests.passed}/${tests.passed + tests.failed}`}</span> : undefined,
    },
    { id: 'timeline', label: 'Timeline' },
    { id: 'raw', label: 'Raw' },
  ];

  return (
    <div className="rv-pane rv-respane">
      <div className="rv-respane__meta" aria-live="polite">
        {res ? (
          <>
            <span className={`rv-status rv-status--${statusClass(res.status)}`} title={`HTTP ${res.httpVersion}`}>
              {res.status} {res.statusText}
            </span>
            <Meta icon="watch" label="Time" value={formatDuration(res.timings.totalMs)} />
            <Meta icon="database" label="Size" value={formatBytes(res.body.size)} title={`Body ${formatBytes(res.body.size)} · headers ${formatBytes(res.headersSize)}`} />
            {res.contentType && <Meta icon="symbol-file" label="Type" value={mimeOf(res.contentType)} title={res.contentType} />}
            {res.redirects.length > 0 && <Meta icon="arrow-swap" label="Redirects" value={String(res.redirects.length)} title={res.redirects.map((r) => `${r.status} ${r.url}`).join('\n')} />}
          </>
        ) : (
          <span className="rv-status rv-status--server-error">Error</span>
        )}
        {response.status === 'cancelled' && <span className="rv-muted">(last send was cancelled)</span>}
        <span className="rv-spacer" />
        {layoutBtn}
      </div>
      {result.error && <ErrorPanel error={result.error} />}
      {result.skipped && <div className="rv-notice rv-notice--info">This request was skipped by a pre-request script.</div>}
      <Tabs tabs={tabs} active={tab} onChange={setResponseTab} ariaLabel="Response" idPrefix={P} />
      <TabPanel idPrefix={P} id={tab} className="rv-respane__panel">
        <ResponseTabContent tab={tab} result={result} />
      </TabPanel>
    </div>
  );
}

function ResponseTabContent({ tab, result }: { tab: ResponseTab; result: ExecutionResult }) {
  const res = result.response;
  switch (tab) {
    case 'body':
      return res ? <ResponseBody response={res} /> : <EmptyState icon="error" title="No response body" />;
    case 'headers':
      return res ? <HeadersView headers={res.headers} /> : <EmptyState icon="list-flat" title="No response headers" />;
    case 'cookies':
      return <CookiesView cookies={res?.cookies ?? []} />;
    case 'tests':
      return <TestResultsView results={result.tests} />;
    case 'timeline':
      return <TimelineView result={result} />;
    case 'raw':
      return <RawView result={result} />;
  }
}

function Meta({ icon, label, value, title }: { icon: string; label: string; value: string; title?: string }) {
  return (
    <span className="rv-meta" title={title ?? `${label}: ${value}`}>
      <Icon name={icon} />
      <span className="rv-sr-only">{label}: </span>
      {value}
    </span>
  );
}

function Loading({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="rv-empty" role="status" aria-live="polite">
      <Icon name="loading" className="rv-empty__icon codicon-modifier-spin" />
      <div className="rv-empty__title">Sending… {formatDuration(Math.max(0, now - startedAt))}</div>
      <Button icon="debug-stop" onClick={cancelRequest}>
        Cancel (Esc)
      </Button>
    </div>
  );
}

function ErrorPanel({ error }: { error: NonNullable<ExecutionResult['error']> }) {
  const [details, setDetails] = useState(false);
  return (
    <div className="rv-error" role="alert">
      <div className="rv-error__head">
        <Icon name="error" />
        <span className="rv-error__code">{error.code}</span>
        <span className="rv-error__msg">{error.message}</span>
      </div>
      {error.hint && (
        <div className="rv-error__hint">
          <Icon name="lightbulb" /> {error.hint}
        </div>
      )}
      {error.details && Object.keys(error.details).length > 0 && (
        <>
          <button type="button" className="rv-link" aria-expanded={details} onClick={() => setDetails(!details)}>
            {details ? 'Hide details' : 'Show details'}
          </button>
          {details && <pre className="rv-pre">{JSON.stringify(error.details, null, 2)}</pre>}
        </>
      )}
    </div>
  );
}
