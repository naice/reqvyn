import type { BodyMode, MultipartPart, RequestBody } from '@reqvyn/core';
import { newId } from '@reqvyn/shared';
import { useRef, useState } from 'react';
import { CodeEditor } from '../../components/CodeEditor';
import { KeyValueTable } from '../../components/KeyValueTable';
import { Segmented } from '../../components/Tabs';
import { VarInput } from '../../components/VarInput';
import { Button, IconButton, Notice } from '../../components/ui';
import { pickFile } from '../../host';
import { formatJson, formatXml } from '../../lib/format';

const MODES: Array<{ value: BodyMode; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'xml', label: 'XML' },
  { value: 'text', label: 'Text' },
  { value: 'urlencoded', label: 'Form URL-encoded' },
  { value: 'multipart', label: 'Multipart form' },
  { value: 'binary', label: 'Binary file' },
  { value: 'graphql', label: 'GraphQL' },
];

function textOf(b: RequestBody): string | undefined {
  return b.mode === 'json' || b.mode === 'xml' || b.mode === 'text' ? b.text : undefined;
}

function convert(from: RequestBody, mode: BodyMode, cache: Map<BodyMode, RequestBody>): RequestBody {
  const cached = cache.get(mode);
  const carry = textOf(from);
  switch (mode) {
    case 'none':
      return { mode };
    case 'json':
    case 'xml':
      return { mode, text: carry ?? (cached && 'text' in cached ? cached.text : '') };
    case 'text':
      return { mode, text: carry ?? (cached?.mode === 'text' ? cached.text : ''), contentType: cached?.mode === 'text' ? cached.contentType : undefined };
    case 'urlencoded':
      return cached?.mode === 'urlencoded' ? cached : { mode, fields: [] };
    case 'multipart':
      return cached?.mode === 'multipart' ? cached : { mode, parts: [] };
    case 'binary':
      return cached?.mode === 'binary' ? cached : { mode, filePath: '' };
    case 'graphql':
      return cached?.mode === 'graphql' ? cached : { mode, query: carry ?? '', variables: '' };
  }
}

export function BodyEditor({ body, onChange }: { body: RequestBody; onChange: (b: RequestBody) => void }) {
  const cache = useRef(new Map<BodyMode, RequestBody>());
  const [error, setError] = useState<string | null>(null);

  const switchMode = (mode: BodyMode) => {
    if (mode === body.mode) return;
    cache.current.set(body.mode, body);
    setError(null);
    onChange(convert(body, mode, cache.current));
  };

  const format = () => {
    if (body.mode !== 'json' && body.mode !== 'xml') return;
    try {
      onChange({ ...body, text: body.mode === 'json' ? formatJson(body.text) : formatXml(body.text) });
      setError(null);
    } catch (e) {
      setError(`Cannot format: ${(e as Error).message}`);
    }
  };

  return (
    <div className="rv-body">
      <div className="rv-body__bar">
        <Segmented options={MODES} value={body.mode} onChange={switchMode} ariaLabel="Body type" />
        <span className="rv-spacer" />
        {(body.mode === 'json' || body.mode === 'xml') && <IconButton icon="list-flat" text="Format" label={`Format ${body.mode.toUpperCase()}`} onClick={format} />}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {body.mode === 'none' && <div className="rv-muted rv-pad">This request has no body.</div>}
      {(body.mode === 'json' || body.mode === 'xml') && (
        <div className="rv-code-box rv-grow">
          <CodeEditor key={body.mode} value={body.text} language={body.mode} variables ariaLabel={`${body.mode.toUpperCase()} body`} onChange={(text) => onChange({ ...body, text })} />
        </div>
      )}
      {body.mode === 'text' && (
        <>
          <div className="rv-form-row">
            <div className="rv-form-row__label">Content-Type</div>
            <div className="rv-form-row__control">
              <input className="rv-input" value={body.contentType ?? ''} placeholder="text/plain" aria-label="Content type" onChange={(e) => onChange({ ...body, contentType: e.target.value || undefined })} />
            </div>
          </div>
          <div className="rv-code-box rv-grow">
            <CodeEditor value={body.text} language="text" variables wrap ariaLabel="Text body" onChange={(text) => onChange({ ...body, text })} />
          </div>
        </>
      )}
      {body.mode === 'urlencoded' && <KeyValueTable rows={body.fields} onChange={(fields) => onChange({ ...body, fields })} ariaLabel="Form fields" bulk description />}
      {body.mode === 'multipart' && <MultipartEditor parts={body.parts} onChange={(parts) => onChange({ ...body, parts })} />}
      {body.mode === 'binary' && (
        <div className="rv-settings">
          <div className="rv-form-row">
            <div className="rv-form-row__label">File</div>
            <div className="rv-form-row__control rv-hstack">
              <VarInput value={body.filePath} ariaLabel="Binary file path" placeholder="No file selected" onChange={(filePath) => onChange({ ...body, filePath })} />
              <Button
                icon="folder-opened"
                onClick={() =>
                  void pickFile('binary').then((p) => {
                    if (p) onChange({ ...body, filePath: p });
                  })
                }
              >
                Choose file…
              </Button>
            </div>
          </div>
          <div className="rv-form-row">
            <div className="rv-form-row__label">Content-Type</div>
            <div className="rv-form-row__control">
              <input className="rv-input" value={body.contentType ?? ''} placeholder="application/octet-stream" aria-label="Content type" onChange={(e) => onChange({ ...body, contentType: e.target.value || undefined })} />
            </div>
          </div>
        </div>
      )}
      {body.mode === 'graphql' && (
        <div className="rv-gql">
          <div className="rv-gql__pane">
            <div className="rv-subhead">Query</div>
            <div className="rv-code-box rv-grow">
              <CodeEditor value={body.query} language="graphql" variables ariaLabel="GraphQL query" placeholder="query { viewer { id } }" onChange={(query) => onChange({ ...body, query })} />
            </div>
          </div>
          <div className="rv-gql__pane">
            <div className="rv-subhead">
              Variables (JSON)
              <IconButton
                icon="list-flat"
                label="Format variables"
                onClick={() => {
                  try {
                    onChange({ ...body, variables: formatJson(body.variables || '{}') });
                    setError(null);
                  } catch (e) {
                    setError(`Cannot format variables: ${(e as Error).message}`);
                  }
                }}
              />
            </div>
            <div className="rv-code-box rv-grow">
              <CodeEditor value={body.variables} language="json" variables ariaLabel="GraphQL variables" placeholder="{}" onChange={(variables) => onChange({ ...body, variables })} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MultipartEditor({ parts, onChange }: { parts: MultipartPart[]; onChange: (p: MultipartPart[]) => void }) {
  const up = (id: string, patch: Partial<MultipartPart>) => onChange(parts.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  return (
    <div className="rv-kv">
      <table className="rv-table" aria-label="Multipart parts">
        <thead>
          <tr>
            <th className="rv-table__check">
              <span className="rv-sr-only">Enabled</span>
            </th>
            <th>Key</th>
            <th className="rv-table__type">Type</th>
            <th>Value</th>
            <th>Content-Type</th>
            <th className="rv-table__actions">
              <span className="rv-sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {parts.map((p) => (
            <tr key={p.id} className={p.enabled ? '' : 'is-disabled'}>
              <td className="rv-table__check">
                <input type="checkbox" checked={p.enabled} aria-label={`Enable ${p.key || 'part'}`} onChange={(e) => up(p.id, { enabled: e.target.checked })} />
              </td>
              <td>
                <input className="rv-cell-input" value={p.key} placeholder="Key" aria-label="Part name" onChange={(e) => up(p.id, { key: e.target.value })} />
              </td>
              <td className="rv-table__type">
                <select className="rv-select" value={p.type} aria-label="Part type" onChange={(e) => up(p.id, { type: e.target.value as MultipartPart['type'] })}>
                  <option value="text">Text</option>
                  <option value="file">File</option>
                </select>
              </td>
              <td>
                {p.type === 'text' ? (
                  <VarInput value={p.value} ariaLabel={`Value of ${p.key || 'part'}`} placeholder="Value" onChange={(value) => up(p.id, { value })} className="rv-cell-var" />
                ) : (
                  <div className="rv-hstack">
                    <span className="rv-file-path rv-mono" title={p.filePath}>
                      {p.filePath || <span className="rv-muted">No file selected</span>}
                    </span>
                    <IconButton
                      icon="folder-opened"
                      label="Choose file"
                      onClick={() =>
                        void pickFile('multipart').then((path) => {
                          if (path) up(p.id, { filePath: path });
                        })
                      }
                    />
                  </div>
                )}
              </td>
              <td>
                <input className="rv-cell-input" value={p.contentType ?? ''} placeholder="auto" aria-label="Part content type" onChange={(e) => up(p.id, { contentType: e.target.value || undefined })} />
              </td>
              <td className="rv-table__actions">
                <IconButton icon="trash" label={`Delete ${p.key || 'part'}`} onClick={() => onChange(parts.filter((x) => x.id !== p.id))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rv-pad-top rv-hstack">
        <Button icon="add" onClick={() => onChange([...parts, { id: newId(), key: '', enabled: true, type: 'text', value: '' }])}>
          Text field
        </Button>
        <Button
          icon="file-add"
          onClick={() =>
            void pickFile('multipart').then((path) => {
              if (path) onChange([...parts, { id: newId(), key: path.split(/[\\/]/).pop() ?? 'file', enabled: true, type: 'file', value: '', filePath: path }]);
            })
          }
        >
          File…
        </Button>
      </div>
    </div>
  );
}
