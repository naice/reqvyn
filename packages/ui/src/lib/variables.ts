import { DYNAMIC_VARIABLES, type UiVariable } from '@reqvyn/core';

export type VariableStatus = 'resolved' | 'unresolved' | 'secret' | 'dynamic';

export interface VariableToken {
  from: number;
  to: number;
  /** Trimmed name inside the braces. */
  name: string;
}

export interface Segment {
  text: string;
  from: number;
  to: number;
  variable?: { name: string; status: VariableStatus };
}

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function findVariableTokens(text: string): VariableToken[] {
  const out: VariableToken[] = [];
  TOKEN.lastIndex = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index === undefined || !m[1]) continue;
    out.push({ from: m.index, to: m.index + m[0].length, name: m[1] });
  }
  return out;
}

const DYNAMIC_NAMES = DYNAMIC_VARIABLES.map((d) => d.name);

export function isDynamicName(name: string): boolean {
  if (!name.startsWith('$')) return false;
  return DYNAMIC_NAMES.some((d) => (d.endsWith(':') ? name.startsWith(d) : name === d || name.startsWith(`${d}:`)));
}

export function lookupVariable(name: string, vars: readonly UiVariable[]): UiVariable | undefined {
  // Later entries win (the host sends variables in precedence order, lowest first) — search from the end.
  for (let i = vars.length - 1; i >= 0; i--) if (vars[i]!.key === name) return vars[i];
  return undefined;
}

export function classifyVariable(name: string, vars: readonly UiVariable[]): VariableStatus {
  if (name.startsWith('$secret:')) return 'secret';
  const v = lookupVariable(name, vars);
  if (v) return v.secret ? 'secret' : 'resolved';
  if (isDynamicName(name)) return 'dynamic';
  return 'unresolved';
}

/** Split text into plain and variable segments (used for highlighting and previews). */
export function segmentText(text: string, vars: readonly UiVariable[]): Segment[] {
  const segs: Segment[] = [];
  let pos = 0;
  for (const t of findVariableTokens(text)) {
    if (t.from > pos) segs.push({ text: text.slice(pos, t.from), from: pos, to: t.from });
    segs.push({ text: text.slice(t.from, t.to), from: t.from, to: t.to, variable: { name: t.name, status: classifyVariable(t.name, vars) } });
    pos = t.to;
  }
  if (pos < text.length) segs.push({ text: text.slice(pos), from: pos, to: text.length });
  return segs;
}

/** Replace resolvable references with their (already masked) values for a preview string. */
export function previewResolved(text: string, vars: readonly UiVariable[]): string {
  return text.replace(TOKEN, (whole, name: string) => {
    const v = lookupVariable(name.trim(), vars);
    if (!v) return whole;
    return v.secret ? '••••••' : v.value;
  });
}

export function tokenAt(text: string, pos: number): VariableToken | undefined {
  return findVariableTokens(text).find((t) => pos >= t.from && pos <= t.to);
}

/**
 * When the cursor is inside an unfinished `{{ ...` reference, returns the start of the typed name
 * and the typed prefix; otherwise `null`.
 */
export function openReferenceBefore(textBefore: string): { from: number; prefix: string } | null {
  const idx = textBefore.lastIndexOf('{{');
  if (idx < 0) return null;
  const after = textBefore.slice(idx + 2);
  if (after.includes('}') || after.includes('{')) return null;
  const lead = after.length - after.trimStart().length;
  return { from: idx + 2 + lead, prefix: after.trimStart() };
}

export interface VariableCompletion {
  label: string;
  detail: string;
  info: string;
  kind: 'variable' | 'secret' | 'dynamic';
}

export function variableCompletions(vars: readonly UiVariable[], prefix: string): VariableCompletion[] {
  const seen = new Set<string>();
  const out: VariableCompletion[] = [];
  for (let i = vars.length - 1; i >= 0; i--) {
    const v = vars[i]!;
    if (seen.has(v.key)) continue;
    seen.add(v.key);
    out.push({ label: v.key, detail: v.source, info: v.secret ? '•••••• (secret)' : v.value, kind: v.secret ? 'secret' : 'variable' });
  }
  for (const d of DYNAMIC_VARIABLES) out.push({ label: d.name, detail: 'dynamic', info: d.description, kind: 'dynamic' });
  const p = prefix.toLowerCase();
  return out
    .filter((c) => !p || c.label.toLowerCase().includes(p))
    .sort((a, b) => Number(!a.label.toLowerCase().startsWith(p)) - Number(!b.label.toLowerCase().startsWith(p)));
}

export function describeVariable(name: string, vars: readonly UiVariable[]): { title: string; value: string; source: string; status: VariableStatus } {
  const status = classifyVariable(name, vars);
  const v = lookupVariable(name, vars);
  if (v) return { title: name, value: v.secret ? '••••••' : v.value, source: v.source, status };
  if (name.startsWith('$secret:')) return { title: name, value: '•••••• (resolved from secret storage at send time)', source: 'secret storage', status };
  if (status === 'dynamic') {
    const d = DYNAMIC_VARIABLES.find((x) => (x.name.endsWith(':') ? name.startsWith(x.name) : name === x.name || name.startsWith(`${x.name}:`)));
    return { title: name, value: d?.description ?? 'Dynamic value', source: 'dynamic', status };
  }
  return { title: name, value: 'Unresolved — not defined in any active scope', source: '', status };
}
