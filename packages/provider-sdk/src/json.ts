/**
 * JSON value types and deterministic canonical serialization.
 *
 * The canonical form sorts object keys recursively, drops `undefined` object members and keeps array
 * order. It is byte-for-byte identical to REQVYN's internal canonical JSON, so hashes computed by a
 * third-party provider with {@link hashJson} match the hashes computed by the REQVYN host.
 *
 * @packageDocumentation
 */

/** A JSON primitive. */
export type JsonPrimitive = string | number | boolean | null;

/** Any JSON-serializable value. Entity payloads in snapshots are opaque `JsonValue`s to providers. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

/** Returns a canonicalized deep copy of `value` (sorted keys, `undefined` members removed). */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/** Deterministic JSON serialization (see module docs). */
export function canonicalJson(value: unknown, indent?: number): string {
  return JSON.stringify(canonicalize(value), null, indent);
}

/** Pretty, deterministic JSON with a trailing newline – suitable for files that end up in Git. */
export function stableStringify(value: unknown): string {
  return canonicalJson(value, 2) + '\n';
}

/** True if `value` is a plain (non-array, non-null) object. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
