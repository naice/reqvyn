/**
 * Deterministic canonical JSON serialization: object keys are sorted recursively, `undefined`
 * values are dropped, and arrays keep their order. Used for content hashing and stable diffs.
 */
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

export function canonicalJson(value: unknown, indent?: number): string {
  return JSON.stringify(canonicalize(value), null, indent);
}

/** Pretty, deterministic JSON for files on disk (stable key order => minimal Git diffs). */
export function stableStringify(value: unknown): string {
  return canonicalJson(value, 2) + '\n';
}

export function deepClone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
