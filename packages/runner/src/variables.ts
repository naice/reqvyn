import type { Collection, Environment, HttpRequest, KeyValue, SecretVault, WritableVariableScope } from '@reqvyn/core';
import { ancestorFolders, secretKeys } from '@reqvyn/core';
import { VariableContext, collectSecretReferences, layerFromKeyValues, layerFromRecord, type VariableLayer } from '@reqvyn/environment-engine';

/**
 * Mutable variable state shared across the requests of one run (or one editor session).
 * Values written by scripts/extractions land here so later requests see them, regardless of
 * whether the host persists them.
 */
export interface VariableState {
  runtime: Map<string, string>;
  /** `null` marks a variable unset by a script (hides the persisted value for the rest of the run). */
  environment: Map<string, string | null>;
  collection: Map<string, string | null>;
  global: Map<string, string | null>;
}

export function createVariableState(): VariableState {
  return { runtime: new Map(), environment: new Map(), collection: new Map(), global: new Map() };
}

export interface VariableSources {
  collection?: Collection;
  request: HttpRequest;
  environment?: Environment | null;
  globals?: KeyValue[];
  workspace?: KeyValue[];
  /** Current data row of a data-driven run. */
  data?: Record<string, string>;
  state?: VariableState;
  vault?: SecretVault;
  /** Process environment for `{{$env:NAME}}` (undefined disables). */
  processEnv?: Record<string, string | undefined>;
}

/** Load secret values for secret rows of an environment / the globals from the vault. */
async function secretValuesFor(
  rows: KeyValue[] | undefined,
  vault: SecretVault | undefined,
  keyFor: (key: string) => string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!rows || !vault) return out;
  for (const r of rows) {
    if (!r.secret || !r.key) continue;
    const v = await vault.get(keyFor(r.key));
    if (v !== undefined) out.set(r.key, v);
  }
  return out;
}

function overlay(layer: VariableLayer, values: Map<string, string | null> | undefined): VariableLayer {
  if (!values) return layer;
  for (const [k, v] of values) {
    if (v === null) {
      layer.values.delete(k);
      continue;
    }
    const prev = layer.values.get(k);
    layer.values.set(k, { value: v, secret: prev?.secret ?? false, source: prev?.source ?? layer.name });
  }
  return layer;
}

/**
 * Build the layered variable context for a request:
 *   global < workspace < collection < folder(s) < environment < data < request < runtime
 */
export async function buildVariableContext(src: VariableSources): Promise<VariableContext> {
  const { collection, request, environment, state, vault } = src;
  const layers: VariableLayer[] = [];
  const globalSecrets = await secretValuesFor(src.globals, vault, secretKeys.globalVariable);
  layers.push(overlay(layerFromKeyValues('global', src.globals ?? [], { label: 'Globals', secretValues: globalSecrets }), state?.global));
  layers.push(layerFromKeyValues('workspace', src.workspace ?? [], { label: 'Workspace' }));
  if (collection) {
    layers.push(overlay(layerFromKeyValues('collection', collection.variables, { label: collection.name }), state?.collection));
    for (const f of ancestorFolders(collection, request.parentId)) layers.push(layerFromKeyValues('folder', f.variables, { label: f.name }));
  } else if (state?.collection.size) {
    layers.push(overlay({ name: 'collection', values: new Map() }, state.collection));
  }
  if (environment) {
    const envSecrets = await secretValuesFor(environment.variables, vault, (k) => secretKeys.environmentVariable(environment.id, k));
    layers.push(overlay(layerFromKeyValues('environment', environment.variables, { label: environment.name, secretValues: envSecrets }), state?.environment));
  } else if (state?.environment.size) {
    layers.push(overlay({ name: 'environment', values: new Map() }, state.environment));
  }
  if (src.data) layers.push(layerFromRecord('data', src.data, 'Data file'));
  layers.push(layerFromKeyValues('request', request.variables, { label: request.name }));
  const runtime: VariableLayer = { name: 'runtime', values: new Map() };
  for (const [k, v] of state?.runtime ?? []) runtime.values.set(k, { value: v, secret: false, source: 'runtime' });
  layers.push(runtime);

  // Named secrets referenced anywhere in the request and its inherited configuration.
  const refs = new Set<string>(collectSecretReferences(request));
  if (collection) {
    const { folders, requests: _requests, ...info } = collection;
    for (const r of collectSecretReferences(info)) refs.add(r);
    for (const f of ancestorFolders({ ...collection, folders }, request.parentId)) for (const r of collectSecretReferences(f)) refs.add(r);
  }
  const namedSecrets = new Map<string, string>();
  if (vault) {
    for (const name of refs) {
      const v = await vault.get(secretKeys.named(name));
      if (v !== undefined) namedSecrets.set(name, v);
    }
  }
  return new VariableContext(layers, { namedSecrets, processEnv: src.processEnv });
}

/** Records the effective values of one writable scope (for script `reqvyn.env.get` etc.). */
export function scopeValues(ctx: VariableContext, layerName: 'environment' | 'collection' | 'global', sources: VariableSources): Record<string, string> {
  const rows =
    layerName === 'environment' ? (sources.environment?.variables ?? []) : layerName === 'collection' ? (sources.collection?.variables ?? []) : (sources.globals ?? []);
  const out: Record<string, string> = {};
  for (const r of rows) if (r.enabled && r.key) out[r.key] = ctx.resolve(`{{${r.key}}}`);
  const overrides = sources.state?.[layerName];
  for (const [k, v] of overrides ?? []) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** Apply a variable change to the context and the shared state. `value === null` unsets. */
export function applyVariableChange(ctx: VariableContext, state: VariableState | undefined, scope: WritableVariableScope, key: string, value: string | null): void {
  if (scope === 'runtime') {
    if (value === null) {
      ctx.unsetRuntime(key);
      state?.runtime.delete(key);
    } else {
      ctx.setRuntime(key, value);
      state?.runtime.set(key, value);
    }
    return;
  }
  if (value === null) {
    ctx.unsetInLayer(scope, key);
    state?.[scope].set(key, null);
  } else {
    ctx.setInLayer(scope, key, value);
    state?.[scope].set(key, value);
  }
}
