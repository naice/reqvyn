import { deepClone } from '@reqvyn/shared';
import { SENSITIVE_AUTH_FIELDS, isTemplate, type Auth, type HttpRequest, type KeyValue } from '@reqvyn/core';

const blank = (rows: KeyValue[]) => rows.map((r) => (r.secret ? { ...r, value: '' } : r));

/** Remove literal secret material from an auth config (templates like {{token}} are kept). */
export function stripAuthSecrets(auth: Auth): Auth {
  const fields = SENSITIVE_AUTH_FIELDS[auth.type] ?? [];
  const copy = { ...auth } as Record<string, unknown>;
  for (const f of fields) {
    const v = copy[f];
    if (typeof v === 'string' && v && !isTemplate(v)) copy[f] = '';
  }
  return copy as Auth;
}

/** Copy of a request without secret values (for history, sharing and reports). */
export function stripRequestSecrets(request: HttpRequest): HttpRequest {
  const r = deepClone(request);
  return {
    ...r,
    headers: blank(r.headers),
    params: blank(r.params),
    cookies: blank(r.cookies),
    variables: blank(r.variables),
    auth: stripAuthSecrets(r.auth),
    body: r.body.mode === 'urlencoded' ? { ...r.body, fields: blank(r.body.fields) } : r.body,
  };
}
