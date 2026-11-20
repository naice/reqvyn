import { CODEGEN_TARGETS, type CodegenTarget } from '@reqvyn/core';
import { useEffect, useRef } from 'react';
import { CodeEditor } from '../../components/CodeEditor';
import { Button, IconButton, Select } from '../../components/ui';
import { copyToClipboard } from '../../host';
import type { LanguageId } from '../../lib/language';
import { closeCodegen, requestCodegen, useRequestStore } from './store';

const LABELS: Record<CodegenTarget, string> = {
  curl: 'cURL',
  fetch: 'JavaScript (fetch)',
  typescript: 'TypeScript (fetch)',
  node: 'Node.js (undici)',
  python: 'Python (requests)',
  csharp: 'C# (HttpClient)',
  powershell: 'PowerShell',
};

const LANG: Record<CodegenTarget, LanguageId> = {
  curl: 'text',
  fetch: 'javascript',
  typescript: 'javascript',
  node: 'javascript',
  python: 'text',
  csharp: 'text',
  powershell: 'text',
};

const OPTIONS = CODEGEN_TARGETS.map((t) => ({ value: t, label: LABELS[t] }));

export function CodegenPanel() {
  const cg = useRequestStore((s) => s.codegen);
  const dialog = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (!cg.open) return;
    returnFocus.current = document.activeElement;
    dialog.current?.querySelector<HTMLElement>('select')?.focus();
    return () => {
      (returnFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [cg.open]);

  if (!cg.open) return null;
  return (
    <div className="rv-modal" onMouseDown={(e) => e.target === e.currentTarget && closeCodegen()}>
      <div
        ref={dialog}
        className="rv-modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rv-codegen-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeCodegen();
          }
        }}
      >
        <div className="rv-modal__head">
          <h2 id="rv-codegen-title" className="rv-modal__title">
            Generate code
          </h2>
          <Select value={cg.target} options={OPTIONS} onChange={(t) => requestCodegen(t)} ariaLabel="Target language" />
          <span className="rv-spacer" />
          <IconButton icon="close" label="Close (Esc)" onClick={closeCodegen} />
        </div>
        <p className="rv-hint">Generated from the current (unsaved) draft of this request.</p>
        <div className="rv-code-box rv-modal__body">
          {cg.loading && !cg.code ? (
            <div className="rv-muted rv-pad">Generating…</div>
          ) : (
            <CodeEditor value={cg.code} language={LANG[cg.target]} readOnly wrap ariaLabel={`Generated ${LABELS[cg.target]} code`} />
          )}
        </div>
        <div className="rv-modal__foot">
          <Button onClick={closeCodegen}>Close</Button>
          <Button primary icon="copy" disabled={!cg.code} onClick={() => copyToClipboard(cg.code)}>
            Copy
          </Button>
        </div>
      </div>
    </div>
  );
}
