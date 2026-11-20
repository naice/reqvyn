import { newId } from '@reqvyn/shared';
import type { KeyValue } from '@reqvyn/core';

/** Placeholder shown instead of secret values in bulk edit mode. Secret values never appear in plaintext. */
export const SECRET_PLACEHOLDER = '********';
const DISABLED_PREFIX = '//';

/**
 * Bulk edit format, one entry per line: `KEY=VALUE` (or `KEY: VALUE`). A leading `//` disables the
 * entry, `#` lines are comments and blank lines are ignored.
 */
export function toBulk(rows: readonly KeyValue[]): string {
  return rows
    .filter((r) => r.key !== '' || r.value !== '')
    .map((r) => `${r.enabled ? '' : DISABLED_PREFIX}${r.key}=${r.secret ? SECRET_PLACEHOLDER : r.value}`)
    .join('\n');
}

export function parseBulk(text: string, existing: readonly KeyValue[] = [], makeId: () => string = newId): KeyValue[] {
  const byKey = new Map<string, KeyValue[]>();
  for (const r of existing) {
    const list = byKey.get(r.key) ?? [];
    list.push(r);
    byKey.set(r.key, list);
  }
  const out: KeyValue[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let enabled = true;
    if (line.startsWith(DISABLED_PREFIX)) {
      enabled = false;
      line = line.slice(DISABLED_PREFIX.length).trim();
    }
    const eq = line.indexOf('=');
    const colon = line.indexOf(':');
    const sep = eq >= 0 && (colon < 0 || eq < colon) ? eq : colon;
    const key = (sep >= 0 ? line.slice(0, sep) : line).trim();
    let value = sep >= 0 ? line.slice(sep + 1) : '';
    if (sep === colon && sep >= 0) value = value.trimStart();
    if (!key) continue;
    const prev = byKey.get(key)?.shift();
    if (prev?.secret) {
      // Unchanged placeholder → keep the stored secret untouched; anything else is a new value to store.
      out.push({ ...prev, enabled, value: value === SECRET_PLACEHOLDER ? prev.value : value });
      continue;
    }
    out.push(prev ? { ...prev, key, value, enabled } : { id: makeId(), key, value, enabled });
  }
  return out;
}

/** Secret rows whose value was changed in bulk mode (must be sent with environment:setSecret). */
export function changedSecrets(before: readonly KeyValue[], after: readonly KeyValue[]): Array<{ key: string; value: string }> {
  const prev = new Map(before.map((r) => [r.id, r]));
  return after.filter((r) => r.secret && prev.has(r.id) && prev.get(r.id)!.value !== r.value).map((r) => ({ key: r.key, value: r.value }));
}
