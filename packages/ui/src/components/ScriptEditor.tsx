import { useState } from 'react';
import { CodeEditor } from './CodeEditor';
import { IconButton, Notice } from './ui';

const PRE_SHEET: Array<[string, string]> = [
  ['reqvyn.variables.get("name")', 'Read a resolved variable'],
  ['reqvyn.variables.set("name", value)', 'Set a runtime variable'],
  ['reqvyn.env.get / reqvyn.env.set', 'Read / write the active environment'],
  ['reqvyn.request.url', 'Read or change the URL'],
  ['reqvyn.request.headers.set("X-Id", v)', 'Add or replace a header'],
  ['reqvyn.request.body', 'Read or replace the body text'],
  ['reqvyn.skipRequest()', 'Skip sending this request'],
  ['await reqvyn.sleep(ms)', 'Wait (limited)'],
  ['console.log(...)', 'Output appears in the Timeline tab'],
];

const POST_SHEET: Array<[string, string]> = [
  ['reqvyn.response.status', 'HTTP status code'],
  ['reqvyn.response.json()', 'Parsed JSON body'],
  ['reqvyn.response.text()', 'Body as text'],
  ['reqvyn.response.headers.get("name")', 'Response header value'],
  ['reqvyn.response.time', 'Response time in ms'],
  ['reqvyn.response.cookies.get("name")', 'Response cookie value'],
  ['reqvyn.test("name", () => { ... })', 'Define a named test'],
  ['reqvyn.expect(v).toBe(x)', 'Assertion (toEqual, toContain, toBeGreaterThan …)'],
  ['reqvyn.env.set("token", v)', 'Store a value for chained requests'],
];

export function ScriptEditor({ value, onChange, kind, trusted }: { value: string; onChange: (v: string) => void; kind: 'pre' | 'post'; trusted?: boolean }) {
  const [sheet, setSheet] = useState(true);
  const rows = kind === 'pre' ? PRE_SHEET : POST_SHEET;
  return (
    <div className="rv-script">
      {trusted === false && (
        <Notice kind="warning" icon="workspace-untrusted">
          This workspace is not trusted — scripts will not run until you trust it.
        </Notice>
      )}
      <div className="rv-script__body">
        <div className="rv-code-box rv-script__editor">
          <CodeEditor
            value={value}
            onChange={onChange}
            language="javascript"
            ariaLabel={kind === 'pre' ? 'Pre-request script' : 'Post-response script'}
            placeholder={kind === 'pre' ? '// Runs before the request is sent' : '// Runs after the response is received'}
          />
        </div>
        {sheet ? (
          <aside className="rv-cheatsheet" aria-label="Scripting API cheat sheet">
            <div className="rv-cheatsheet__head">
              <strong>API</strong>
              <IconButton icon="close" label="Hide cheat sheet" onClick={() => setSheet(false)} />
            </div>
            <dl>
              {rows.map(([code, desc]) => (
                <div key={code}>
                  <dt>
                    <code>{code}</code>
                  </dt>
                  <dd>{desc}</dd>
                </div>
              ))}
            </dl>
          </aside>
        ) : (
          <IconButton icon="book" label="Show API cheat sheet" onClick={() => setSheet(true)} className="rv-script__sheetbtn" />
        )}
      </div>
    </div>
  );
}
