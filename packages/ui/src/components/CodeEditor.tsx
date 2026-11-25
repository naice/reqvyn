import { useEffect, useRef } from 'react';
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
  rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import type { LanguageId } from '../lib/language';
import { languageExtension } from '../editor/languages';
import { createSearchPanel } from '../editor/searchPanel';
import { baseTheme, highlighting } from '../editor/theme';
import { variableCompletionSource, variablesExtension } from '../editor/variablesExt';

const External = Annotation.define<boolean>();

/** Search shortcuts CodeMirror binds (Mod-f, Mod-g, Mod-Alt-g, F3) that VS Code would also act on. */
function isEditorSearchKey(e: KeyboardEvent): boolean {
  if (e.key === 'F3') return true;
  const key = e.key.toLowerCase();
  return (e.ctrlKey || e.metaKey) && (key === 'f' || key === 'g');
}

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language: LanguageId;
  readOnly?: boolean;
  /** Enable {{variable}} highlighting, hover and autocomplete. */
  variables?: boolean;
  ariaLabel: string;
  wrap?: boolean;
  lineNumbers?: boolean;
  placeholder?: string;
  className?: string;
  /** Receives the EditorView (for search, folding, focus) once created. */
  onView?: (view: EditorView | null) => void;
}

export function CodeEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastValue = useRef(props.value);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  const compartments = useRef({ lang: new Compartment(), wrap: new Compartment(), ro: new Compartment() });

  useEffect(() => {
    const c = compartments.current;
    const exts: Extension[] = [
      props.lineNumbers === false ? [] : [lineNumbers(), foldGutter(), highlightActiveLineGutter()],
      highlightSpecialChars(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      bracketMatching(),
      search({ top: true, createPanel: createSearchPanel }),
      baseTheme,
      highlighting,
      c.lang.of(languageExtension(props.language)),
      c.wrap.of(props.wrap ? EditorView.lineWrapping : []),
      c.ro.of(EditorState.readOnly.of(!!props.readOnly)),
      EditorView.contentAttributes.of({ 'aria-label': props.ariaLabel }),
      props.placeholder ? placeholderExt(props.placeholder) : [],
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || u.transactions.some((t) => t.annotation(External))) return;
        const text = u.state.doc.toString();
        lastValue.current = text;
        onChange.current?.(text);
      }),
    ];
    if (!props.readOnly) exts.push(history(), indentOnInput(), closeBrackets());
    if (props.variables) exts.push(variablesExtension(), autocompletion({ override: [variableCompletionSource] }));
    else if (!props.readOnly && props.language === 'javascript') exts.push(autocompletion());
    const view = new EditorView({ state: EditorState.create({ doc: props.value, extensions: exts }), parent: host.current! });
    viewRef.current = view;
    lastValue.current = props.value;
    props.onView?.(view);
    // VS Code forwards webview keydowns to the workbench, where Ctrl+F opens the webview find widget (and Ctrl+G
    // "Go to Line") and steals focus from CodeMirror's own search panel. Once the editor has handled such a key,
    // keep it from bubbling up to the forwarding listener on window.
    const el = host.current!;
    const keepSearchKeys = (e: KeyboardEvent) => {
      if (e.defaultPrevented && isEditorSearchKey(e)) e.stopPropagation();
    };
    el.addEventListener('keydown', keepSearchKeys);
    return () => {
      el.removeEventListener('keydown', keepSearchKeys);
      props.onView?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // Editors are re-created only when structural options change; value/language/wrap are synced below.
  }, [props.readOnly, props.variables, props.lineNumbers]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || props.value === lastValue.current) return;
    lastValue.current = props.value;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value }, annotations: External.of(true) });
  }, [props.value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.lang.reconfigure(languageExtension(props.language)) });
  }, [props.language]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.wrap.reconfigure(props.wrap ? EditorView.lineWrapping : []) });
  }, [props.wrap]);

  return <div ref={host} className={`rv-code ${props.className ?? ''}`} />;
}
