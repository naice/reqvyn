import { newId, ReqvynError, REDACTED } from '@reqvyn/shared';
import { VARIABLE_PATTERN, type KeyValue, type UiVariable, type VariableLayerName } from '@reqvyn/core';
import { evaluateDynamic } from './dynamic.js';

export interface ResolvedVariable {
  value: string;
  secret: boolean;
  source: string;
}

export interface VariableLayer {
  name: VariableLayerName;
  /** Human-readable label (e.g. environment or folder name). */
  label?: string;
  values: Map<string, ResolvedVariable>;
}

export interface VariableContextOptions {
  /** Named secrets referenced by {{$secret:name}} (pre-fetched from the vault). */
  namedSecrets?: Map<string, string>;
  /** Process environment for {{$env:NAME}}. Pass `undefined` to disable. */
  processEnv?: Record<string, string | undefined>;
  /** Called when a named secret is referenced but missing (for diagnostics). */
  maxDepth?: number;
}

export interface ResolveResult {
  value: string;
  unresolved: string[];
  usedSecrets: string[];
}

/** Build a layer from key/value rows. Disabled rows are ignored. Secret rows take their value from `secretValues`. */
export function layerFromKeyValues(
  name: VariableLayerName,
  rows: KeyValue[],
  opts: { label?: string; secretValues?: Map<string, string> } = {},
): VariableLayer {
  const values = new Map<string, ResolvedVariable>();
  for (const r of rows) {
    if (!r.enabled || !r.key) continue;
    const value = r.secret ? (opts.secretValues?.get(r.key) ?? r.value ?? '') : r.value;
    values.set(r.key, { value, secret: !!r.secret, source: opts.label ? `${name}: ${opts.label}` : name });
  }
  return { name, label: opts.label, values };
}

export function layerFromRecord(name: VariableLayerName, record: Record<string, string>, label?: string): VariableLayer {
  const values = new Map<string, ResolvedVariable>();
  for (const [k, v] of Object.entries(record)) values.set(k, { value: v, secret: false, source: label ? `${name}: ${label}` : name });
  return { name, label, values };
}

/**
 * Variable context with layered precedence (lowest first):
 *   global < workspace < collection < folder(s) < environment < data < request < runtime
 * Values may reference other variables; cycles are detected and reported.
 */
export class VariableContext {
  private readonly layers: VariableLayer[];
  private readonly runtime: VariableLayer;
  private readonly namedSecrets: Map<string, string>;
  private readonly processEnv?: Record<string, string | undefined>;
  private readonly maxDepth: number;
  private readonly usedSecretValues = new Set<string>();

  constructor(layers: VariableLayer[], opts: VariableContextOptions = {}) {
    this.layers = [...layers];
    const existingRuntime = this.layers.find((l) => l.name === 'runtime');
    this.runtime = existingRuntime ?? { name: 'runtime', values: new Map() };
    if (!existingRuntime) this.layers.push(this.runtime);
    this.namedSecrets = opts.namedSecrets ?? new Map();
    this.processEnv = opts.processEnv;
    this.maxDepth = opts.maxDepth ?? 20;
    for (const l of this.layers) for (const v of l.values.values()) if (v.secret && v.value) this.usedSecretValues.add(v.value);
    for (const v of this.namedSecrets.values()) if (v) this.usedSecretValues.add(v);
  }

  /** Highest-precedence variable for `key`. */
  lookup(key: string): ResolvedVariable | undefined {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const v = this.layers[i]!.values.get(key);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  has(key: string): boolean {
    return this.lookup(key) !== undefined;
  }

  /** Set a runtime variable (highest precedence). */
  setRuntime(key: string, value: string, secret = false): void {
    this.runtime.values.set(key, { value, secret, source: 'runtime' });
    if (secret && value) this.usedSecretValues.add(value);
  }

  unsetRuntime(key: string): void {
    this.runtime.values.delete(key);
  }

  /** Set a value in a named layer (creating it if necessary). */
  setInLayer(name: VariableLayerName, key: string, value: string): void {
    let layer = [...this.layers].reverse().find((l) => l.name === name);
    if (!layer) {
      layer = { name, values: new Map() };
      // keep precedence order: insert before runtime
      this.layers.splice(this.layers.indexOf(this.runtime), 0, layer);
    }
    const prev = layer.values.get(key);
    layer.values.set(key, { value, secret: prev?.secret ?? false, source: prev?.source ?? name });
    if (prev?.secret && value) this.usedSecretValues.add(value);
  }

  unsetInLayer(name: VariableLayerName, key: string): void {
    for (const l of this.layers) if (l.name === name) l.values.delete(key);
  }

  /** Flat snapshot of all visible variables (resolved), used by scripts. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const l of this.layers) for (const [k] of l.values) out[k] = this.resolve(`{{${k}}}`);
    return out;
  }

  runtimeValues(): Record<string, string> {
    return Object.fromEntries([...this.runtime.values].map(([k, v]) => [k, v.value]));
  }

  /** All secret values known to this context (for redaction of logs, reports and UI previews). */
  secretValues(): string[] {
    return [...this.usedSecretValues];
  }

  resolve(text: string): string {
    return this.resolveDetailed(text).value;
  }

  resolveDetailed(text: string): ResolveResult {
    const unresolved = new Set<string>();
    const usedSecrets = new Set<string>();
    const value = this.resolveInner(text, [], unresolved, usedSecrets);
    return { value, unresolved: [...unresolved], usedSecrets: [...usedSecrets] };
  }

  /** Resolve for display: secrets are masked. */
  preview(text: string): string {
    const r = this.resolveDetailed(text);
    let out = r.value;
    for (const s of this.secretValues()) if (s.length >= 3) out = out.split(s).join(REDACTED);
    return out;
  }

  private resolveInner(text: string, stack: string[], unresolved: Set<string>, usedSecrets: Set<string>): string {
    if (!text || text.indexOf('{{') === -1) return text;
    if (stack.length > this.maxDepth) {
      throw new ReqvynError('CYCLE', `Variable nesting too deep: ${stack.join(' → ')}`);
    }
    return text.replace(new RegExp(VARIABLE_PATTERN.source, 'g'), (match, rawName: string) => {
      const name = rawName.trim();
      if (name.startsWith('$')) {
        const dyn = this.resolveSpecial(name, usedSecrets);
        if (dyn === undefined) {
          unresolved.add(name);
          return match;
        }
        return dyn;
      }
      if (stack.includes(name)) {
        throw new ReqvynError('CYCLE', `Circular variable reference: ${[...stack, name].join(' → ')}`, {
          hint: 'Change one of the variables so it does not reference itself (directly or indirectly).',
        });
      }
      const v = this.lookup(name);
      if (!v) {
        unresolved.add(name);
        return match;
      }
      if (v.secret) usedSecrets.add(name);
      return this.resolveInner(v.value, [...stack, name], unresolved, usedSecrets);
    });
  }

  private resolveSpecial(name: string, usedSecrets: Set<string>): string | undefined {
    if (name.startsWith('$secret:')) {
      const key = name.slice('$secret:'.length).trim();
      const v = this.namedSecrets.get(key);
      if (v !== undefined) {
        usedSecrets.add(name);
        this.usedSecretValues.add(v);
      }
      return v;
    }
    if (name.startsWith('$env:')) {
      if (!this.processEnv) return undefined;
      return this.processEnv[name.slice('$env:'.length).trim()];
    }
    return evaluateDynamic(name);
  }

  /** Variables for the UI (secret values masked), highest precedence wins. */
  toUiVariables(): UiVariable[] {
    const map = new Map<string, UiVariable>();
    for (const l of this.layers) {
      for (const [k, v] of l.values) map.set(k, { key: k, value: v.secret ? REDACTED : v.value, source: v.source, secret: v.secret });
    }
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
}

/** Collect every `{{$secret:name}}` reference in an arbitrary JSON value. */
export function collectSecretReferences(value: unknown): string[] {
  const text = JSON.stringify(value) ?? '';
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*\$secret:([^{}]+?)\s*\}\}/g)) if (m[1]) out.add(m[1].trim());
  return [...out];
}

export function newVariableRow(key: string, value: string, secret = false): KeyValue {
  return { id: newId(), key, value, enabled: true, secret: secret || undefined };
}
