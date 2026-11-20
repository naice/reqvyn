import { SENSITIVE_AUTH_FIELDS, isTemplate, type Auth, type HttpRequest, type KeyValue, type Folder, type CollectionInfo } from '@reqvyn/core';

function stripRows(rows: KeyValue[] | undefined): KeyValue[] | undefined {
  return rows?.map((r) => (r.secret ? { ...r, value: '' } : r));
}

/**
 * Remove values of rows marked `secret` (variables, headers, params) before persisting.
 * Secret values live in the SecretVault, never in collection/environment files.
 */
export function stripSecretValues<T extends object>(entity: T): T {
  const e = entity as Record<string, unknown>;
  const out: Record<string, unknown> = { ...e };
  for (const key of ['variables', 'headers', 'params', 'cookies']) {
    if (Array.isArray(e[key])) out[key] = stripRows(e[key] as KeyValue[]);
  }
  return out as T;
}

export interface InlineSecret {
  /** Vault name (used as `{{$secret:<name>}}`). */
  name: string;
  value: string;
  field: string;
}

/** Vault name for an inline auth secret of an entity. */
export function authSecretName(ownerId: string, field: string): string {
  return `auth.${ownerId}.${field}`;
}

/**
 * Find literal (non-template) values in sensitive auth fields and replace them with
 * `{{$secret:...}}` references. The caller stores the returned secrets in the vault.
 */
export function extractInlineAuthSecrets(auth: Auth, ownerId: string): { auth: Auth; secrets: InlineSecret[] } {
  const fields = SENSITIVE_AUTH_FIELDS[auth.type] ?? [];
  const secrets: InlineSecret[] = [];
  const next = { ...auth } as Record<string, unknown>;
  for (const field of fields) {
    const value = next[field];
    if (typeof value !== 'string' || value === '' || isTemplate(value)) continue;
    const name = authSecretName(ownerId, field);
    secrets.push({ name, value, field });
    next[field] = `{{$secret:${name}}}`;
  }
  return { auth: next as Auth, secrets };
}

/** Apply `extractInlineAuthSecrets` to a request, folder or collection info. */
export function extractEntitySecrets<T extends HttpRequest | Folder | CollectionInfo>(entity: T): { entity: T; secrets: InlineSecret[] } {
  const { auth, secrets } = extractInlineAuthSecrets(entity.auth, entity.id);
  return { entity: secrets.length ? { ...entity, auth } : entity, secrets };
}

/** True when any sensitive auth field contains a literal value. */
export function hasInlineSecrets(auth: Auth): boolean {
  return (SENSITIVE_AUTH_FIELDS[auth.type] ?? []).some((f) => {
    const v = (auth as Record<string, unknown>)[f];
    return typeof v === 'string' && v !== '' && !isTemplate(v);
  });
}
