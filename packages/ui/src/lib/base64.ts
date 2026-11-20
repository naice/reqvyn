export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToText(bytes: Uint8Array, charset = 'utf-8'): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function charsetOf(contentType: string): string {
  const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return m?.[1]?.toLowerCase() ?? 'utf-8';
}

/** Hex dump of the first bytes for binary bodies. */
export function hexDump(bytes: Uint8Array, max = 4096): string {
  const lines: string[] = [];
  const n = Math.min(bytes.length, max);
  for (let off = 0; off < n; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, n));
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (bytes.length > max) lines.push(`… ${bytes.length - max} more bytes`);
  return lines.join('\n');
}
