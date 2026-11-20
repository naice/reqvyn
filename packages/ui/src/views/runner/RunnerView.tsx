import { formatDuration } from '@reqvyn/shared';
import { useCallback, useMemo, useState } from 'react';
import { RunnerSettingsEditor } from '../../components/SettingsEditor';
import { Segmented } from '../../components/Tabs';
import { WindowedList } from '../../components/WindowedList';
import { Button, Checkbox, EmptyState, Icon, IconButton, Notice, Section, Select } from '../../components/ui';
import { pickFile } from '../../host';
import { statusClass } from '../../lib/format';
import { methodClass } from '../../lib/methods';
import { failedTests } from '../../lib/timings';
import { cancelRun, editForm, exportRun, openRequest, resultFailed, setFilter, startRun, toggleSkip, useRunnerStore, type RunResult } from './store';

const ROW = 30;
const DETAIL_LINE = 20;

export function RunnerView() {
  const config = useRunnerStore((s) => s.config);
  const status = useRunnerStore((s) => s.status);
  if (!config) return <EmptyState icon="loading" title="Loading runner…" />;
  return (
    <div className="rv-view rv-runner">
      <header className="rv-topbar">
        <Icon name="run-all" />
        <span className="rv-topbar__title">Run {config.collectionName}</span>
        <span className="rv-spacer" />
        {status === 'running' ? (
          <Button icon="debug-stop" onClick={cancelRun}>
            Cancel
          </Button>
        ) : (
          <Button primary icon="play" onClick={startRun} disabled={config.requests.length === 0}>
            Run
          </Button>
        )}
      </header>
      <div className="rv-runner__body">
        <aside className="rv-runner__config rv-scroll" aria-label="Run configuration">
          <RunnerConfig />
        </aside>
        <section className="rv-runner__results" aria-label="Run results">
          <Progress />
          <Results />
        </section>
      </div>
    </div>
  );
}

function RunnerConfig() {
  const config = useRunnerStore((s) => s.config)!;
  const environments = useRunnerStore((s) => s.environments);
  const form = useRunnerStore((s) => s.form);
  const running = useRunnerStore((s) => s.status === 'running');
  const skip = new Set(form.skip);
  const envOptions = [{ value: '', label: 'No environment' }, ...environments.map((e) => ({ value: e.id, label: e.name }))];

  return (
    <fieldset disabled={running} className="rv-fieldset">
      <legend className="rv-sr-only">Run configuration</legend>
      <Section title="Options">
        <div className="rv-settings">
          <div className="rv-form-row">
            <label className="rv-form-row__label" htmlFor="run-env">
              Environment
            </label>
            <div className="rv-form-row__control">
              <Select id="run-env" value={form.environmentId ?? ''} options={envOptions} onChange={(v) => editForm({ environmentId: v || null })} />
            </div>
          </div>
        </div>
        <RunnerSettingsEditor settings={form} onChange={(s) => editForm(s)} />
        <div className="rv-settings">
          <div className="rv-form-row">
            <div className="rv-form-row__label">Data file</div>
            <div className="rv-form-row__control rv-hstack">
              <span className="rv-file-path rv-mono" title={form.dataFile}>
                {form.dataFile ? form.dataFile.split(/[\\/]/).pop() : <span className="rv-muted">None (CSV or JSON)</span>}
              </span>
              <IconButton
                icon="folder-opened"
                label="Choose data file (CSV/JSON); one iteration per row"
                onClick={() =>
                  void pickFile('data').then((p) => {
                    if (p) editForm({ dataFile: p });
                  })
                }
              />
              {form.dataFile && <IconButton icon="close" label="Remove data file" onClick={() => editForm({ dataFile: undefined })} />}
            </div>
          </div>
          <div className="rv-form-row">
            <div className="rv-form-row__label" />
            <div className="rv-form-row__control">
              <Checkbox checked={form.persistVariables} onChange={(v) => editForm({ persistVariables: v })} label="Persist variable changes to the environment" />
            </div>
          </div>
        </div>
      </Section>
      <Section
        title={`Requests (${config.requests.length - skip.size}/${config.requests.length})`}
        actions={
          <>
            <IconButton icon="check-all" label="Select all requests" onClick={() => editForm({ skip: [] })} />
            <IconButton icon="clear-all" label="Deselect all requests" onClick={() => editForm({ skip: config.requests.map((r) => r.id) })} />
          </>
        }
      >
        {config.requests.length === 0 ? (
          <p className="rv-muted">This {config.folderId ? 'folder' : 'collection'} has no requests.</p>
        ) : (
          <ul className="rv-runlist" aria-label="Requests to run">
            {config.requests.map((r) => (
              <li key={r.id} className={skip.has(r.id) ? 'is-disabled' : ''}>
                <label className="rv-runlist__item" title={r.path}>
                  <input type="checkbox" checked={!skip.has(r.id)} onChange={(e) => toggleSkip(r.id, !e.target.checked)} />
                  <span className={`rv-method ${methodClass(r.method)}`}>{r.method}</span>
                  <span className="rv-runlist__name">{r.name}</span>
                  {r.path && <span className="rv-runlist__path rv-muted">{r.path}</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </fieldset>
  );
}

function Progress() {
  const status = useRunnerStore((s) => s.status);
  const progress = useRunnerStore((s) => s.progress);
  const summary = useRunnerStore((s) => s.summary);
  const error = useRunnerStore((s) => s.error);

  if (status === 'idle') return null;
  const pct = progress && progress.total > 0 ? Math.min(100, (progress.completed / progress.total) * 100) : 0;
  return (
    <div className="rv-runprogress">
      {error && (
        <Notice kind="error">
          {error.code}: {error.message}
          {error.hint ? ` — ${error.hint}` : ''}
        </Notice>
      )}
      {status === 'running' && (
        <div aria-live="polite">
          <div className="rv-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Run progress">
            <div className="rv-progress__bar" style={{ width: `${pct}%` }} />
          </div>
          <div className="rv-muted rv-runprogress__text">
            {progress ? `${progress.completed}/${progress.total}` : 'Starting…'}
            {progress && progress.totalIterations > 1 && ` · iteration ${progress.iteration}/${progress.totalIterations}`}
            {progress?.current && ` · ${progress.current.name}`}
          </div>
        </div>
      )}
      {summary && (
        <div className="rv-summary" role="status">
          <div className="rv-summary__stats">
            {summary.cancelled && <span className="rv-badge rv-badge--warning">Cancelled</span>}
            <Stat label="Total" value={summary.total} />
            <Stat label="Passed" value={summary.passed} kind="pass" />
            <Stat label="Failed" value={summary.failed} kind={summary.failed ? 'fail' : undefined} />
            <Stat label="Errored" value={summary.errored} kind={summary.errored ? 'fail' : undefined} />
            <Stat label="Skipped" value={summary.skipped} />
            <Stat
              label="Assertions"
              value={`${summary.assertions.passed}/${summary.assertions.passed + summary.assertions.failed}`}
              kind={summary.assertions.failed ? 'fail' : 'pass'}
            />
            <Stat label="Duration" value={formatDuration(summary.durationMs)} />
          </div>
          <div className="rv-hstack">
            <span className="rv-muted">Export:</span>
            <Button icon="json" onClick={() => exportRun('json')}>
              JSON
            </Button>
            <Button icon="file-code" onClick={() => exportRun('html')}>
              HTML
            </Button>
            <Button icon="checklist" onClick={() => exportRun('junit')}>
              JUnit
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, kind }: { label: string; value: number | string; kind?: 'pass' | 'fail' }) {
  return (
    <div className={`rv-stat ${kind ? `rv-${kind}` : ''}`}>
      <div className="rv-stat__value">{value}</div>
      <div className="rv-stat__label">{label}</div>
    </div>
  );
}

function detailLines(r: RunResult): number {
  return failedTests(r.tests).length + (r.error ? 1 : 0);
}

interface Item {
  r: RunResult;
  key: string;
}

function Results() {
  const results = useRunnerStore((s) => s.results);
  const status = useRunnerStore((s) => s.status);
  const filter = useRunnerStore((s) => s.filter);
  const multiIteration = useRunnerStore((s) => (s.progress?.totalIterations ?? 1) > 1);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const items = useMemo<Item[]>(() => {
    const list = results.map((r, i) => ({ r, key: `${i}:${r.iteration}:${r.requestId ?? r.requestName}` }));
    return filter === 'failed' ? list.filter((x) => resultFailed(x.r)) : list;
  }, [results, filter]);
  const failedCount = useMemo(() => results.filter(resultFailed).length, [results]);

  const itemHeight = useCallback((x: Item) => ROW + (expanded.has(x.key) ? detailLines(x.r) * DETAIL_LINE + 6 : 0), [expanded]);
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (results.length === 0) {
    if (status === 'idle')
      return (
        <EmptyState icon="run-all" title="Configure the run and press Run">
          Results stream in here as each request completes.
        </EmptyState>
      );
    return status === 'running' ? null : <EmptyState icon="info" title="No requests were executed" />;
  }

  return (
    <div className="rv-results">
      <div className="rv-body__bar">
        <Segmented
          options={[
            { value: 'all' as const, label: `All (${results.length})` },
            { value: 'failed' as const, label: `Failed (${failedCount})` },
          ]}
          value={filter}
          onChange={setFilter}
          ariaLabel="Filter results"
        />
      </div>
      <WindowedList
        className="rv-grow"
        ariaLabel="Request results"
        items={items}
        getKey={(x) => x.key}
        itemHeight={itemHeight}
        stickToBottom={status === 'running'}
        renderItem={(x) => <ResultRow r={x.r} showIteration={multiIteration} expanded={expanded.has(x.key)} onToggle={() => toggle(x.key)} />}
      />
    </div>
  );
}

function ResultRow({ r, expanded, onToggle, showIteration }: { r: RunResult; expanded: boolean; onToggle: () => void; showIteration: boolean }) {
  const failed = resultFailed(r);
  const fails = failedTests(r.tests);
  const res = r.response;
  const canExpand = fails.length > 0 || !!r.error;
  const state = r.skipped ? 'skipped' : failed ? 'failed' : 'passed';
  const time = r.durationMs !== undefined ? formatDuration(r.durationMs) : res ? formatDuration(res.timings.totalMs) : '';
  return (
    <div className={`rv-result is-${state}`}>
      <div className="rv-result__row" style={{ height: ROW }}>
        {canExpand ? (
          <IconButton icon={expanded ? 'chevron-down' : 'chevron-right'} label={expanded ? 'Collapse details' : 'Expand details'} onClick={onToggle} />
        ) : (
          <span className="rv-result__spacer" />
        )}
        <Icon name={r.skipped ? 'debug-step-over' : failed ? 'error' : 'pass'} className={r.skipped ? 'rv-muted' : failed ? 'rv-fail' : 'rv-pass'} />
        <span className="rv-sr-only">{state}: </span>
        {showIteration && <span className="rv-muted rv-result__iter">#{r.iteration}</span>}
        {r.requestId ? (
          <button type="button" className="rv-link rv-result__name" onClick={() => openRequest(r.requestId!)} title="Open request">
            {r.requestName}
          </button>
        ) : (
          <span className="rv-result__name">{r.requestName}</span>
        )}
        <span className="rv-spacer" />
        {res && <span className={`rv-status rv-status--${statusClass(res.status)}`}>{res.status}</span>}
        {r.error && !res && <span className="rv-status rv-status--server-error">{r.error.code}</span>}
        <span className="rv-muted rv-result__time">{time}</span>
      </div>
      {expanded && (
        <ul className="rv-result__details">
          {r.error && (
            <li style={{ height: DETAIL_LINE }} className="rv-fail rv-ellipsis" title={r.error.message}>
              {r.error.code}: {r.error.message}
            </li>
          )}
          {fails.map((f) => (
            <li key={f.result.id} style={{ height: DETAIL_LINE }} className="rv-ellipsis" title={f.result.message}>
              <Icon name="close" className="rv-fail" /> {[...f.path, f.result.name].join(' › ')}
              {f.result.message && <span className="rv-muted"> — {f.result.message}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
