import { VARIABLE_SCOPES, type Extraction } from '@reqvyn/core';
import { newId } from '@reqvyn/shared';
import { Button, IconButton, Select } from './ui';

type Source = Extraction['source'];

const SOURCES: Array<{ value: Source; label: string }> = [
  { value: 'json', label: 'JSON path' },
  { value: 'header', label: 'Header' },
  { value: 'cookie', label: 'Cookie' },
  { value: 'status', label: 'Status code' },
  { value: 'regex', label: 'Regex on body' },
  { value: 'body', label: 'Whole body' },
];

const PLACEHOLDER: Record<Source, string> = {
  json: '$.data.token',
  header: 'Location',
  cookie: 'session',
  status: '',
  regex: 'id="(\\d+)"',
  body: '',
};

/** Visual response extraction for request chaining (no JavaScript required). */
export function ExtractionBuilder({ rows, onChange }: { rows: Extraction[]; onChange: (rows: Extraction[]) => void }) {
  const up = (id: string, patch: Partial<Extraction>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div className="rv-extract">
      {rows.length === 0 && <div className="rv-muted rv-pad">Extract values from the response into variables, e.g. save <code>$.token</code> as <code>accessToken</code>.</div>}
      {rows.length > 0 && (
        <table className="rv-table" aria-label="Extractions">
          <thead>
            <tr>
              <th className="rv-table__check">
                <span className="rv-sr-only">Enabled</span>
              </th>
              <th>Variable</th>
              <th>From</th>
              <th>Path / name / pattern</th>
              <th>Scope</th>
              <th className="rv-table__actions">
                <span className="rv-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.enabled ? '' : 'is-disabled'}>
                <td className="rv-table__check">
                  <input type="checkbox" checked={r.enabled} aria-label={`Enable extraction ${r.variable}`} onChange={(e) => up(r.id, { enabled: e.target.checked })} />
                </td>
                <td>
                  <input className="rv-cell-input rv-mono" value={r.variable} placeholder="variableName" aria-label="Variable name" spellCheck={false} onChange={(e) => up(r.id, { variable: e.target.value.replace(/[{}\s]/g, '') })} />
                </td>
                <td>
                  <Select value={r.source} ariaLabel="Extraction source" options={SOURCES} onChange={(v) => up(r.id, { source: v })} />
                </td>
                <td>
                  {r.source === 'status' || r.source === 'body' ? (
                    <span className="rv-muted">—</span>
                  ) : (
                    <input className="rv-cell-input rv-mono" value={r.path} placeholder={PLACEHOLDER[r.source]} aria-label="Path" spellCheck={false} onChange={(e) => up(r.id, { path: e.target.value })} />
                  )}
                </td>
                <td>
                  <Select value={r.scope} ariaLabel="Variable scope" options={VARIABLE_SCOPES.map((s) => ({ value: s, label: s }))} onChange={(v) => up(r.id, { scope: v })} />
                </td>
                <td className="rv-table__actions">
                  <IconButton icon="trash" label={`Delete extraction ${r.variable}`} onClick={() => onChange(rows.filter((x) => x.id !== r.id))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="rv-pad-top">
        <Button icon="add" onClick={() => onChange([...rows, { id: newId(), enabled: true, variable: '', source: 'json', path: '$.', scope: 'runtime' }])}>
          Extraction
        </Button>
      </div>
    </div>
  );
}
