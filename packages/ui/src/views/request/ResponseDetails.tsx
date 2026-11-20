import type { Cookie, ExecutionResult, TestResult, TimelineEvent } from '@reqvyn/core';
import { formatDuration } from '@reqvyn/shared';
import { useMemo, useState } from 'react';
import { EmptyState, Icon, IconButton } from '../../components/ui';
import { copyToClipboard } from '../../host';
import { countTests, timingSegments } from '../../lib/timings';

export function HeadersView({ headers }: { headers: Array<[string, string]> }) {
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? headers.filter(([k, v]) => k.toLowerCase().includes(f) || v.toLowerCase().includes(f)) : headers;
  }, [headers, filter]);
  if (headers.length === 0) return <EmptyState icon="list-flat" title="No headers" />;
  return (
    <div className="rv-scroll rv-grow">
      <div className="rv-body__bar">
        <input className="rv-input rv-input--search" type="search" placeholder="Filter headers" aria-label="Filter headers" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="rv-spacer" />
        <IconButton icon="copy" label="Copy all headers" onClick={() => copyToClipboard(headers.map(([k, v]) => `${k}: ${v}`).join('\n'))} />
      </div>
      <table className="rv-table rv-table--readonly" aria-label="Response headers">
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
            <th className="rv-table__actions">
              <span className="rv-sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={`${k}-${i}`}>
              <td className="rv-mono rv-nowrap">{k}</td>
              <td className="rv-mono rv-break">{v}</td>
              <td className="rv-table__actions">
                <IconButton icon="copy" label={`Copy ${k}`} onClick={() => copyToClipboard(v)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CookiesView({ cookies }: { cookies: Cookie[] }) {
  if (cookies.length === 0) return <EmptyState icon="globe" title="No cookies were set by this response" />;
  return (
    <div className="rv-scroll rv-grow">
      <table className="rv-table rv-table--readonly" aria-label="Response cookies">
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
            <th>Domain</th>
            <th>Path</th>
            <th>Expires</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {cookies.map((c, i) => (
            <tr key={`${c.name}-${i}`}>
              <td className="rv-mono">{c.name}</td>
              <td className="rv-mono rv-break">{c.value}</td>
              <td>{c.domain ?? ''}</td>
              <td>{c.path ?? ''}</td>
              <td>{c.maxAge !== undefined ? `max-age ${c.maxAge}s` : (c.expires ?? 'Session')}</td>
              <td>{[c.secure && 'Secure', c.httpOnly && 'HttpOnly', c.sameSite && `SameSite=${c.sameSite}`].filter(Boolean).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TestResultsView({ results }: { results: TestResult[] }) {
  const [onlyFailed, setOnlyFailed] = useState(false);
  const counts = countTests(results);
  if (results.length === 0)
    return (
      <EmptyState icon="beaker" title="No tests ran">
        Add assertions or <code>rq.test()</code> calls in the Tests tab.
      </EmptyState>
    );
  return (
    <div className="rv-scroll rv-grow">
      <div className="rv-body__bar">
        <span className={counts.failed ? 'rv-fail' : 'rv-pass'}>
          {counts.passed} passed, {counts.failed} failed
        </span>
        <span className="rv-spacer" />
        <label className="rv-check">
          <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} /> Only failures
        </label>
      </div>
      <ul className="rv-tests" aria-label="Test results">
        {results.map((r) => (
          <TestNode key={r.id} r={r} onlyFailed={onlyFailed} />
        ))}
      </ul>
    </div>
  );
}

function TestNode({ r, onlyFailed }: { r: TestResult; onlyFailed: boolean }) {
  if (onlyFailed && r.passed) return null;
  return (
    <li className={`rv-test ${r.passed ? 'is-pass' : 'is-fail'}`}>
      <Icon name={r.passed ? 'pass' : 'error'} className={r.passed ? 'rv-pass' : 'rv-fail'} />
      <span className="rv-sr-only">{r.passed ? 'Passed' : 'Failed'}: </span>
      <span className="rv-test__name">{r.name}</span>
      {r.source === 'script' && <span className="rv-badge">script</span>}
      {r.message && <div className="rv-test__msg rv-mono">{r.message}</div>}
      {r.children && r.children.length > 0 && (
        <ul>
          {r.children.map((c) => (
            <TestNode key={c.id} r={c} onlyFailed={onlyFailed} />
          ))}
        </ul>
      )}
    </li>
  );
}

const EVENT_ICONS: Record<TimelineEvent['type'], string> = {
  info: 'info',
  request: 'arrow-up',
  response: 'arrow-down',
  redirect: 'arrow-swap',
  tls: 'lock',
  dns: 'globe',
  connect: 'plug',
  error: 'error',
  script: 'code',
  auth: 'key',
};

export function TimelineView({ result }: { result: ExecutionResult }) {
  const res = result.response;
  const segs = res ? timingSegments(res.timings) : [];
  const total = res?.timings.totalMs ?? 0;
  return (
    <div className="rv-scroll rv-grow rv-timeline">
      {res && (
        <section aria-label="Timing breakdown">
          <h3 className="rv-subhead">Timing · {formatDuration(total)}</h3>
          {segs.length === 0 ? (
            <p className="rv-muted">No detailed timings available.</p>
          ) : (
            <div className="rv-waterfall" role="list">
              {segs.map((s) => (
                <div key={s.key} className="rv-waterfall__row" role="listitem">
                  <span className="rv-waterfall__label">{s.label}</span>
                  <span className="rv-waterfall__track" aria-hidden="true">
                    <span
                      className={`rv-waterfall__bar rv-waterfall__bar--${s.key}`}
                      style={{ left: `${total ? (s.start / total) * 100 : 0}%`, width: `${total ? Math.max(0.5, (s.duration / total) * 100) : 0}%` }}
                    />
                  </span>
                  <span className="rv-waterfall__value">{formatDuration(s.duration)}</span>
                </div>
              ))}
            </div>
          )}
          {res.remoteAddress && <p className="rv-muted">Remote address: {res.remoteAddress}</p>}
        </section>
      )}
      {res && res.timeline.length > 0 && (
        <section aria-label="Events">
          <h3 className="rv-subhead">Events</h3>
          <ol className="rv-events">
            {res.timeline.map((e, i) => (
              <li key={i} className={`rv-event rv-event--${e.type}`}>
                <span className="rv-event__time rv-mono">+{formatDuration(Math.max(0, e.at - res.timings.startedAt))}</span>
                <Icon name={EVENT_ICONS[e.type] ?? 'info'} />
                <span className="rv-event__msg rv-mono">{e.message}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {result.console.length > 0 && (
        <section aria-label="Script console">
          <h3 className="rv-subhead">Console</h3>
          <ol className="rv-events">
            {result.console.map((c, i) => (
              <li key={i} className={`rv-event rv-console--${c.level}`}>
                <span className="rv-event__time rv-mono">{c.level}</span>
                <span className="rv-event__msg rv-mono">{c.message}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {result.variableChanges.length > 0 && (
        <section aria-label="Variable changes">
          <h3 className="rv-subhead">Variables set</h3>
          <table className="rv-table rv-table--readonly">
            <thead>
              <tr>
                <th>Scope</th>
                <th>Name</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {result.variableChanges.map((v, i) => (
                <tr key={i}>
                  <td>{v.scope}</td>
                  <td className="rv-mono">{v.key}</td>
                  <td className="rv-mono rv-break">{v.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {!res && result.console.length === 0 && <EmptyState icon="history" title="No timeline data" />}
    </div>
  );
}

/** Raw HTTP exchange as sent/received (sensitive headers were redacted by the host). */
export function RawView({ result }: { result: ExecutionResult }) {
  const res = result.response;
  const text = useMemo(() => {
    if (!res) return '';
    const s = res.sentRequest;
    const reqPart = [`${s.method} ${s.url}`, ...s.headers.map(([k, v]) => `${k}: ${v}`), '', s.bodyPreview ?? ''].join('\n');
    const resPart = [`HTTP/${res.httpVersion} ${res.status} ${res.statusText}`, ...res.headers.map(([k, v]) => `${k}: ${v}`)].join('\n');
    return `${reqPart.trimEnd()}\n\n${'-'.repeat(40)}\n\n${resPart}`;
  }, [res]);
  if (!res) return <EmptyState icon="file-code" title="Nothing was received" />;
  return (
    <div className="rv-scroll rv-grow">
      <div className="rv-body__bar">
        <span className="rv-muted">Request as sent · response headers</span>
        <span className="rv-spacer" />
        <IconButton icon="copy" label="Copy raw exchange" onClick={() => copyToClipboard(text)} />
      </div>
      <pre className="rv-pre rv-mono" aria-label="Raw HTTP exchange">
        {text}
      </pre>
    </div>
  );
}
