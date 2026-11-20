import { memo, useEffect, useRef } from 'react';
import { Annotation, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { singleLineTheme } from '../editor/theme';
import { variableCompletionSource, variablesExtension } from '../editor/variablesExt';

const External = Annotation.define<boolean>();

export interface VarInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  onEnter?: () => void;
  className?: string;
  readOnly?: boolean;
  /** Called when focus leaves the editor. */
  onBlur?: () => void;
}

/**
 * Single-line input (CodeMirror) with `{{variable}}` highlighting, hover preview and `{{`
 * autocomplete. Newlines are stripped (pasting multi-line text joins it).
 */
export const VarInput = memo(function VarInput(props: VarInputProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastValue = useRef(props.value);
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value.replace(/\r?\n/g, ''),
        extensions: [
          history(),
          drawSelection(),
          singleLineTheme,
          variablesExtension(),
          autocompletion({ override: [variableCompletionSource], icons: false }),
          EditorState.readOnly.of(!!props.readOnly),
          EditorState.transactionFilter.of((tr) => {
            if (!tr.docChanged || tr.newDoc.lines <= 1) return tr;
            const joined = tr.newDoc.toString().replace(/\r?\n/g, '');
            return [tr, { changes: { from: 0, to: tr.newDoc.length, insert: joined }, selection: { anchor: joined.length }, sequential: true }];
          }),
          keymap.of([
            {
              key: 'Enter',
              run: () => {
                cb.current.onEnter?.();
                return true;
              },
            },
            ...completionKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.contentAttributes.of({ 'aria-label': props.ariaLabel, 'aria-multiline': 'false', role: 'textbox' }),
          props.placeholder ? placeholderExt(props.placeholder) : [],
          EditorView.domEventHandlers({ blur: () => cb.current.onBlur?.() }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.some((t) => t.annotation(External))) return;
            const text = u.state.doc.toString();
            lastValue.current = text;
            cb.current.onChange(text);
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => view.destroy();
  }, [props.readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || props.value === lastValue.current) return;
    lastValue.current = props.value;
    if (view.state.doc.toString() === props.value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value }, annotations: External.of(true) });
  }, [props.value]);

  return <div ref={host} className={`rv-varinput ${props.readOnly ? 'is-readonly' : ''} ${props.className ?? ''}`} />;
});
