const KNOWN = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** CSS class carrying the method colour (`rv-m-get`, ..., `rv-m-custom`). */
export function methodClass(method: string): string {
  const m = method.toUpperCase();
  return KNOWN.has(m) ? `rv-m-${m.toLowerCase()}` : 'rv-m-custom';
}
