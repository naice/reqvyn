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
import { baseTheme, highlighting } from '../editor/theme';
import { variableCompletionSource, variablesExtension } from '../editor/variablesExt';

const External = Annotation.define<boolean>();

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
      search({ top: true }),
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
    return () => {
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
