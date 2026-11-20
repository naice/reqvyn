/**
 * Stable identifiers. IDs are random v4 UUIDs; they never encode names or positions so that
 * renames, moves and re-orderings never break references or synchronization.
 */
export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const hex = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}
