import { RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, hoverTooltip, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { UiVariable } from '@reqvyn/core';
import { classifyVariable, describeVariable, findVariableTokens, openReferenceBefore, tokenAt, variableCompletions, type VariableStatus } from '../lib/variables';

/**
 * CodeMirror support for `{{variable}}` references: highlighting (resolved / unresolved / secret /
 * dynamic), `{{` autocomplete and hover preview. The variable list is global for the webview and
 * pushed to all live editors when the host sends new variables.
 */

let current: readonly UiVariable[] = [];
const liveViews = new Set<EditorView>();
const refreshVariables = StateEffect.define<null>();

export function setEditorVariables(vars: readonly UiVariable[]): void {
  current = vars;
  for (const v of liveViews) v.dispatch({ effects: refreshVariables.of(null) });
}

export function getEditorVariables(): readonly UiVariable[] {
  return current;
}

const marks: Record<VariableStatus, Decoration> = {
  resolved: Decoration.mark({ class: 'rv-var rv-var--resolved' }),
  unresolved: Decoration.mark({ class: 'rv-var rv-var--unresolved' }),
  secret: Decoration.mark({ class: 'rv-var rv-var--secret' }),
  dynamic: Decoration.mark({ class: 'rv-var rv-var--dynamic' }),
};

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const t of findVariableTokens(text)) builder.add(from + t.from, from + t.to, marks[classifyVariable(t.name, current)]);
  }
  return builder.finish();
}

const highlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(readonly view: EditorView) {
      liveViews.add(view);
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refreshVariables)))) {
        this.decorations = buildDecorations(u.view);
      }
    }
    destroy() {
      liveViews.delete(this.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const STATUS_LABEL: Record<VariableStatus, string> = {
  resolved: 'Resolved',
  unresolved: 'Unresolved',
  secret: 'Secret',
  dynamic: 'Dynamic',
};

export function variableTooltipDom(name: string): HTMLElement {
  const d = describeVariable(name, current);
  const dom = document.createElement('div');
  dom.className = `rv-var-tip rv-var-tip--${d.status}`;
  const head = document.createElement('div');
  head.className = 'rv-var-tip__head';
  const n = document.createElement('code');
  n.textContent = d.title;
  const s = document.createElement('span');
  s.className = 'rv-var-tip__status';
  s.textContent = STATUS_LABEL[d.status];
  head.append(n, s);
  const value = document.createElement('div');
  value.className = 'rv-var-tip__value';
  value.textContent = d.value === '' ? '(empty)' : d.value;
  dom.append(head, value);
  if (d.source) {
    const src = document.createElement('div');
    src.className = 'rv-var-tip__source';
    src.textContent = `Source: ${d.source}`;
    dom.append(src);
  }
  return dom;
}

const hover = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos);
  const t = tokenAt(line.text, pos - line.from);
  if (!t) return null;
  return { pos: line.from + t.from, end: line.from + t.to, above: true, create: () => ({ dom: variableTooltipDom(t.name) }) };
});

/** Completion source for `{{` references. */
export function variableCompletionSource(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const open = openReferenceBefore(before);
  if (!open) return null;
  const after = line.text.slice(ctx.pos - line.from);
  const closes = /^\s*\}\}/.test(after);
  const options: Completion[] = variableCompletions(current, '').map((c) => ({
    label: c.label,
    detail: c.detail,
    info: c.info,
    type: c.kind === 'dynamic' ? 'function' : c.kind === 'secret' ? 'constant' : 'variable',
    apply: closes || c.label.endsWith(':') ? c.label : `${c.label}}}`,
  }));
  return { from: line.from + open.from, options, validFor: /^[^{}\s]*$/ };
}

/** Highlight + hover. Autocomplete is added by the editor component (one `autocompletion()` per editor). */
export function variablesExtension(): Extension {
  return [highlightPlugin, hover];
}
