import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Content hash over the canonical JSON representation. */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
