export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export function jsonKind(v: unknown): JsonKind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'object':
      return 'object';
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'null';
  }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Append a key or index to a JSONPath (`$.a.b[0]['weird key']`). */
export function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  if (IDENT.test(key)) return `${parent}.${key}`;
  return `${parent}['${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
}

export function pathFromSegments(segments: Array<string | number>): string {
  return segments.reduce<string>((p, s) => childPath(p, s), '$');
}

export interface JsonChild {
  key: string | number;
  value: unknown;
}

/** Children of a container node, sliced for lazy rendering. */
export function jsonChildren(v: unknown, offset = 0, limit = Infinity): JsonChild[] {
  if (Array.isArray(v)) {
    const end = Math.min(v.length, offset + limit);
    const out: JsonChild[] = [];
    for (let i = offset; i < end; i++) out.push({ key: i, value: v[i] });
    return out;
  }
  if (v && typeof v === 'object') {
    return Object.keys(v)
      .slice(offset, offset === 0 && limit === Infinity ? undefined : offset + limit)
      .map((k) => ({ key: k, value: (v as Record<string, unknown>)[k] }));
  }
  return [];
}

export function childCount(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return 0;
}

/** One-line preview of a value for collapsed nodes. */
export function previewValue(v: unknown, max = 80): string {
  const kind = jsonKind(v);
  if (kind === 'array') return `Array(${(v as unknown[]).length})`;
  if (kind === 'object') {
    const n = childCount(v);
    return `{${n} ${n === 1 ? 'key' : 'keys'}}`;
  }
  const s = kind === 'string' ? JSON.stringify(v) : String(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function copyableValue(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}
