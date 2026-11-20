import type { SyncConfigField, SyncConfigValues, SyncProviderCapabilities, SyncProviderDescriptor } from './types.js';

const FIELD_TYPES = new Set(['string', 'secret', 'boolean', 'number', 'path', 'url']);
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CAPABILITY_KEYS: Array<keyof SyncProviderCapabilities> = ['read', 'write', 'optimisticConcurrency', 'list', 'delete', 'auth'];

/** A validation problem. */
export interface ConfigIssue {
  key?: string;
  message: string;
}

/** Validate a provider descriptor (id format, capabilities, config schema). Returns all issues. */
export function validateDescriptor(descriptor: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (typeof descriptor !== 'object' || descriptor === null) return [{ message: 'Descriptor must be an object' }];
  const d = descriptor as Partial<SyncProviderDescriptor>;
  if (typeof d.id !== 'string' || !PROVIDER_ID_RE.test(d.id)) {
    issues.push({ key: 'id', message: 'Provider id must match [a-z0-9][a-z0-9._-]* (max 128 chars)' });
  }
  if (typeof d.displayName !== 'string' || !d.displayName.trim()) issues.push({ key: 'displayName', message: 'displayName is required' });
  if (typeof d.capabilities !== 'object' || d.capabilities === null) {
    issues.push({ key: 'capabilities', message: 'capabilities are required' });
  } else {
    for (const k of CAPABILITY_KEYS) {
      if (typeof (d.capabilities as unknown as Record<string, unknown>)[k] !== 'boolean') {
        issues.push({ key: `capabilities.${k}`, message: `capabilities.${k} must be a boolean` });
      }
    }
    if (d.capabilities.optimisticConcurrency && !d.capabilities.write) {
      issues.push({ key: 'capabilities.optimisticConcurrency', message: 'optimisticConcurrency requires write' });
    }
  }
  if (!Array.isArray(d.configSchema)) {
    issues.push({ key: 'configSchema', message: 'configSchema must be an array' });
  } else {
    const seen = new Set<string>();
    for (const f of d.configSchema as SyncConfigField[]) {
      if (typeof f !== 'object' || f === null || typeof f.key !== 'string' || !KEY_RE.test(f.key)) {
        issues.push({ key: 'configSchema', message: 'Config field keys must match [A-Za-z0-9_-]{1,64}' });
        continue;
      }
      if (seen.has(f.key)) issues.push({ key: f.key, message: `Duplicate config field "${f.key}"` });
      seen.add(f.key);
      if (!FIELD_TYPES.has(f.type)) issues.push({ key: f.key, message: `Unsupported field type "${String(f.type)}"` });
      if (typeof f.label !== 'string' || !f.label) issues.push({ key: f.key, message: 'Field label is required' });
      if (f.type === 'secret' && f.default !== undefined) issues.push({ key: f.key, message: 'Secret fields cannot have defaults' });
    }
  }
  return issues;
}

/**
 * Validate non-secret configuration values against a schema and apply defaults. Secret fields must
 * NOT appear in `values` (they live in the secret store); `secretsPresent` lists which required
 * secrets are set.
 */
export function validateConfigValues(
  schema: readonly SyncConfigField[],
  values: Record<string, unknown>,
  secretsPresent: ReadonlySet<string> = new Set(),
): { values: SyncConfigValues; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const out: Record<string, string | number | boolean | undefined> = {};
  const known = new Set(schema.map((f) => f.key));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) issues.push({ key, message: `Unknown config field "${key}"` });
  }
  for (const f of schema) {
    const raw = values[f.key];
    if (f.type === 'secret') {
      if (raw !== undefined) issues.push({ key: f.key, message: 'Secret values must be stored in secret storage, not in configuration' });
      if (f.required && !secretsPresent.has(f.key)) issues.push({ key: f.key, message: `${f.label} is required` });
      continue;
    }
    const v = raw === undefined || raw === '' ? f.default : raw;
    if (v === undefined) {
      if (f.required) issues.push({ key: f.key, message: `${f.label} is required` });
      continue;
    }
    switch (f.type) {
      case 'boolean':
        if (typeof v !== 'boolean') issues.push({ key: f.key, message: `${f.label} must be true or false` });
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) issues.push({ key: f.key, message: `${f.label} must be a number` });
        break;
      case 'url':
        if (typeof v !== 'string' || !isValidUrl(v)) issues.push({ key: f.key, message: `${f.label} must be an absolute http(s) URL` });
        break;
      default:
        if (typeof v !== 'string') issues.push({ key: f.key, message: `${f.label} must be text` });
        else if (v.includes('\0')) issues.push({ key: f.key, message: `${f.label} contains invalid characters` });
    }
    out[f.key] = v as string | number | boolean;
  }
  return { values: Object.freeze(out), issues };
}

function isValidUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Convenience accessors for typed config values. */
export function configString(config: SyncConfigValues, key: string): string | undefined {
  const v = config[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function configNumber(config: SyncConfigValues, key: string): number | undefined {
  const v = config[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function configBoolean(config: SyncConfigValues, key: string): boolean | undefined {
  const v = config[key];
  return typeof v === 'boolean' ? v : undefined;
}
