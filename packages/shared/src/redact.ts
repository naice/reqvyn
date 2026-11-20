export const REDACTED = '••••••';

/** Replace every occurrence of any secret value in `text` with a mask. Values shorter than 3 chars are ignored to avoid over-masking. */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  const list = [...new Set([...secrets].filter((s) => typeof s === 'string' && s.length >= 3))].sort(
    (a, b) => b.length - a.length,
  );
  let out = text;
  for (const s of list) out = out.split(s).join(REDACTED);
  return out;
}

export function maskValue(value: string): string {
  return value ? REDACTED : '';
}

const SENSITIVE_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token)$/i;
const SENSITIVE_KEY = /(pass(word)?|secret|token|api[-_]?key|apikey|credential|private[-_]?key|session|signature)/i;

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER.test(name.trim());
}

export function isSensitiveKey(name: string): boolean {
  return SENSITIVE_KEY.test(name);
}
