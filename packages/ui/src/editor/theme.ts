import { EditorView } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';

/** Editor chrome bound to VS Code theme variables; token colours come from `tok-*` classes in CSS. */
export const baseTheme = EditorView.theme({
  '&': {
    color: 'var(--vscode-editor-foreground)',
    backgroundColor: 'var(--vscode-editor-background)',
    fontFamily: 'var(--vscode-editor-font-family)',
    fontSize: 'var(--vscode-editor-font-size, 13px)',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--vscode-editorCursor-foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--vscode-editor-selectionBackground) !important',
  },
  '.cm-activeLine': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground, transparent)' },
  '.cm-gutters': {
    backgroundColor: 'var(--vscode-editorGutter-background, var(--vscode-editor-background))',
    color: 'var(--vscode-editorLineNumber-foreground)',
    border: 'none',
  },
  '.cm-activeLineGutter': { color: 'var(--vscode-editorLineNumber-activeForeground)', backgroundColor: 'transparent' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--vscode-editor-foldBackground, transparent)',
    border: '1px solid var(--vscode-panel-border)',
    color: 'var(--vscode-descriptionForeground)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground)',
    outline: '1px solid var(--vscode-editor-findMatchHighlightBorder, transparent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--vscode-editor-findMatchBackground)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--vscode-editor-selectionHighlightBackground)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--vscode-editorBracketMatch-background)',
    outline: '1px solid var(--vscode-editorBracketMatch-border, transparent)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--vscode-editorWidget-background)',
    color: 'var(--vscode-editorWidget-foreground, var(--vscode-foreground))',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border))' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border))' },
  '.cm-tooltip': {
    backgroundColor: 'var(--vscode-editorHoverWidget-background)',
    color: 'var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground))',
    border: '1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border))',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground))',
    color: 'var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground))',
  },
  '.cm-completionDetail': { color: 'var(--vscode-descriptionForeground)', marginLeft: '1em', fontStyle: 'normal' },
  '.cm-completionMatchedText': { color: 'var(--vscode-editorSuggestWidget-highlightForeground)', textDecoration: 'none', fontWeight: '600' },
  '.cm-placeholder': { color: 'var(--vscode-input-placeholderForeground)' },
});

/** Single-line editors look like VS Code inputs. */
export const singleLineTheme = EditorView.theme({
  '&': {
    color: 'var(--vscode-input-foreground)',
    backgroundColor: 'transparent',
    fontFamily: 'var(--vscode-editor-font-family)',
    fontSize: 'var(--vscode-font-size, 13px)',
    height: 'auto',
  },
  '.cm-scroller': { overflow: 'hidden', lineHeight: '20px' },
  '.cm-content': { padding: '2px 0', caretColor: 'var(--vscode-editorCursor-foreground, var(--vscode-input-foreground))' },
  '.cm-line': { padding: '0 6px' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
});

export const highlighting = syntaxHighlighting(classHighlighter);
