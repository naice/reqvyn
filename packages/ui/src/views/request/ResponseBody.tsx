import type { HttpResponseData } from '@reqvyn/core';
import { formatBytes } from '@reqvyn/shared';
import { openSearchPanel } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import { useMemo, useRef, useState } from 'react';
import { CodeEditor } from '../../components/CodeEditor';
import { JsonTree } from '../../components/JsonTree';
import { Segmented } from '../../components/Tabs';
import { Button, IconButton, Notice, Select } from '../../components/ui';
import { copyToClipboard, getUiState, post, setUiState } from '../../host';
import { base64ToBytes, bytesToText, charsetOf, hexDump } from '../../lib/base64';
import { tryFormatJson, formatXml } from '../../lib/format';
import { detectLanguage, isBinary, isImageType, LANGUAGE_LABELS, mimeOf, type LanguageId } from '../../lib/language';

type Mode = 'pretty' | 'raw' | 'tree' | 'preview';

/** Bodies above this size are not pretty-printed/highlighted unless the user insists. */
export const PRETTY_LIMIT = 1_500_000;

const LANG_OPTIONS = (Object.keys(LANGUAGE_LABELS) as LanguageId[]).map((id) => ({ value: id, label: LANGUAGE_LABELS[id] }));

export function ResponseBody({ response }: { response: HttpResponseData }) {
  const body = response.body;
  const bytes = useMemo(() => base64ToBytes(body.base64), [body.base64]);
  const binary = useMemo(() => isBinary(response.contentType, bytes), [response.contentType, bytes]);
  const text = useMemo(() => (binary ? '' : bytesToText(bytes, charsetOf(response.contentType))), [binary, bytes, response.contentType]);
  const detected = useMemo(() => detectLanguage(response.contentType, text), [response.contentType, text]);
  const [langOverride, setLangOverride] = useState<LanguageId | null>(null);
  const lang = langOverride ?? detected;
  const [mode, setModeState] = useState<Mode>(() => getUiState<Mode>('bodyMode', 'pretty'));
  const [wrap, setWrapState] = useState<boolean>(() => getUiState('bodyWrap', true));
  const [forceLarge, setForceLarge] = useState(false);
  const view = useRef<EditorView | null>(null);

  const setMode = (m: Mode) => {
    setModeState(m);
    setUiState('bodyMode', m);
  };
  const setWrap = (w: boolean) => {
    setWrapState(w);
    setUiState('bodyWrap', w);
  };

  const large = text.length > PRETTY_LIMIT && !forceLarge;
  const parsedJson = useMemo(() => {
    if (lang !== 'json' || large) return undefined;
    try {
      return { value: JSON.parse(text) as unknown };
    } catch {
      return undefined;
    }
  }, [lang, text, large]);

  const pretty = useMemo(() => {
    if (large) return text;
    if (lang === 'json') return tryFormatJson(text) ?? text;
    if (lang === 'xml') {
      try {
        return formatXml(text);
      } catch {
        return text;
      }
    }
    return text;
  }, [lang, text, large]);

  const image = isImageType(response.contentType);
  const modes: Array<{ value: Mode; label: string }> = [
    { value: 'pretty', label: 'Pretty' },
    { value: 'raw', label: 'Raw' },
  ];
  if (parsedJson) modes.push({ value: 'tree', label: 'Tree' });
  if (lang === 'html' || image) modes.push({ value: 'preview', label: 'Preview' });
  const effectiveMode: Mode = modes.some((m) => m.value === mode) ? mode : 'pretty';

  const toolbar = (
    <div className="rv-body__bar">
      {!binary && <Segmented options={modes} value={effectiveMode} onChange={setMode} ariaLabel="Body view" />}
      {!binary && effectiveMode !== 'tree' && effectiveMode !== 'preview' && (
        <Select value={lang} options={LANG_OPTIONS} onChange={(v) => setLangOverride(v === detected ? null : v)} ariaLabel="Syntax language" className="rv-select--compact" />
      )}
      <span className="rv-spacer" />
      {!binary && effectiveMode !== 'tree' && effectiveMode !== 'preview' && (
        <>
          <IconButton icon="word-wrap" label="Toggle word wrap" active={wrap} onClick={() => setWrap(!wrap)} />
          <IconButton icon="search" label="Find in body (Ctrl+F)" onClick={() => view.current && openSearchPanel(view.current)} />
        </>
      )}
      {!binary && <IconButton icon="copy" label="Copy body" onClick={() => copyToClipboard(effectiveMode === 'pretty' ? pretty : text)} />}
      <IconButton icon="save" label="Save body to file" onClick={() => post({ type: 'response:saveBody' })} />
      <IconButton icon="go-to-file" label="Open body in editor" onClick={() => post({ type: 'response:openInEditor' })} />
      <IconButton icon="diff" label="Compare with previous response" onClick={() => post({ type: 'response:compare' })} />
    </div>
  );

  return (
    <div className="rv-resbody">
      {toolbar}
      {body.truncated && (
        <Notice kind="warning">
          Showing the first {formatBytes(bytes.length)} of {formatBytes(body.size)}.{' '}
          {body.savedTo ? `The full body was saved to ${body.savedTo}.` : 'Use “Save body” to get the full response.'}
        </Notice>
      )}
      {text.length > PRETTY_LIMIT && !forceLarge && !binary && (
        <Notice kind="info">
          Large body ({formatBytes(text.length)}) — formatting is disabled for performance.{' '}
          <button type="button" className="rv-link" onClick={() => setForceLarge(true)}>
            Format anyway
          </button>
        </Notice>
      )}
      {binary ? (
        image ? (
          <ImagePreview bytes={bytes} contentType={response.contentType} />
        ) : (
          <div className="rv-grow rv-scroll">
            <p className="rv-muted rv-pad">
              Binary content ({mimeOf(response.contentType) || 'unknown type'}, {formatBytes(body.size)}). Save the body to inspect it with another tool.
            </p>
            <pre className="rv-pre rv-hex" aria-label="Hex dump">
              {hexDump(bytes)}
            </pre>
          </div>
        )
      ) : effectiveMode === 'tree' && parsedJson ? (
        <div className="rv-grow rv-scroll">
          <JsonTree value={parsedJson.value} />
        </div>
      ) : effectiveMode === 'preview' ? (
        image ? <ImagePreview bytes={bytes} contentType={response.contentType} /> : <HtmlPreview html={text} />
      ) : text.length === 0 ? (
        <div className="rv-muted rv-pad">Response body is empty.</div>
      ) : (
        <div className="rv-code-box rv-grow">
          <CodeEditor
            value={effectiveMode === 'pretty' ? pretty : text}
            language={effectiveMode === 'pretty' && !large ? lang : 'text'}
            readOnly
            wrap={wrap}
            ariaLabel="Response body"
            onView={(v) => (view.current = v)}
          />
        </div>
      )}
    </div>
  );
}

function ImagePreview({ bytes, contentType }: { bytes: Uint8Array; contentType: string }) {
  const url = useMemo(() => {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return `data:${mimeOf(contentType) || 'image/png'};base64,${btoa(bin)}`;
  }, [bytes, contentType]);
  return (
    <div className="rv-grow rv-scroll rv-imgprev">
      <img src={url} alt="Response image preview" />
    </div>
  );
}

/**
 * HTML preview in a fully sandboxed iframe (no scripts, no same-origin). The webview CSP still applies to
 * the srcdoc document, so external resources (images, styles) referenced by the page are not loaded.
 */
function HtmlPreview({ html }: { html: string }) {
  const [show, setShow] = useState(false);
  if (!show) {
    return (
      <div className="rv-pad">
        <Notice kind="info">The preview renders the HTML without scripts or external resources.</Notice>
        <Button icon="eye" onClick={() => setShow(true)}>
          Render preview
        </Button>
      </div>
    );
  }
  return <iframe className="rv-grow rv-htmlprev" title="HTML preview" sandbox="" srcDoc={html} />;
}
