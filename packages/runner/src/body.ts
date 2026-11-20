import { isAbsolute, join } from 'node:path';
import { ReqvynError } from '@reqvyn/shared';
import type { RequestBody } from '@reqvyn/core';
import { bufferBody, fileBody, multipartBody, type PreparedBody } from '@reqvyn/http-engine';

export type Resolve = (text: string) => string;

/** Default Content-Type per body mode (only added when the user did not set one). */
export function defaultContentType(body: RequestBody): string | undefined {
  switch (body.mode) {
    case 'json':
    case 'graphql':
      return 'application/json';
    case 'xml':
      return 'application/xml';
    case 'text':
      return body.contentType || 'text/plain; charset=utf-8';
    case 'urlencoded':
      return 'application/x-www-form-urlencoded';
    case 'binary':
      return body.contentType || undefined;
    default:
      return undefined;
  }
}

function formEncode(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, '+');
}

/**
 * The editable textual form of a body that is shown to pre-request scripts (unresolved templates).
 * Multipart and binary bodies are not exposed as text.
 */
export function bodyTextForScript(body: RequestBody): string | undefined {
  switch (body.mode) {
    case 'json':
    case 'xml':
    case 'text':
      return body.text;
    case 'graphql':
      return body.query;
    case 'urlencoded':
      return body.fields
        .filter((f) => f.enabled && f.key)
        .map((f) => `${formEncode(f.key)}=${formEncode(f.value)}`)
        .join('&');
    default:
      return undefined;
  }
}

export function resolvePath(p: string, baseDir?: string): string {
  if (!p) throw new ReqvynError('VALIDATION', 'No file selected for the request body.');
  return isAbsolute(p) ? p : join(baseDir ?? process.cwd(), p);
}

/**
 * Turn a request body into a re-openable PreparedBody. `override` is the body text after a
 * pre-request script changed it; it replaces the configured body (sent with the mode's content type).
 */
export async function prepareBody(body: RequestBody, resolve: Resolve, opts: { baseDir?: string; override?: string } = {}): Promise<PreparedBody | undefined> {
  if (opts.override !== undefined) {
    if (body.mode === 'graphql') return graphqlBody(opts.override, body.variables, resolve);
    return bufferBody(resolve(opts.override), defaultContentType(body) ?? 'text/plain; charset=utf-8');
  }
  switch (body.mode) {
    case 'none':
      return undefined;
    case 'json':
    case 'xml':
    case 'text':
      return bufferBody(resolve(body.text), defaultContentType(body));
    case 'graphql':
      return graphqlBody(body.query, body.variables, resolve);
    case 'urlencoded': {
      const text = body.fields
        .filter((f) => f.enabled && f.key)
        .map((f) => `${formEncode(resolve(f.key))}=${formEncode(resolve(f.value))}`)
        .join('&');
      return bufferBody(text, 'application/x-www-form-urlencoded');
    }
    case 'multipart':
      return multipartBody(
        body.parts
          .filter((p) => p.enabled && p.key)
          .map((p) =>
            p.type === 'file'
              ? { name: resolve(p.key), type: 'file' as const, filePath: resolvePath(resolve(p.filePath ?? p.value), opts.baseDir), contentType: p.contentType || undefined }
              : { name: resolve(p.key), type: 'text' as const, value: resolve(p.value), contentType: p.contentType || undefined },
          ),
      );
    case 'binary':
      return fileBody(resolvePath(resolve(body.filePath), opts.baseDir), body.contentType || undefined);
  }
}

function graphqlBody(query: string, variables: string, resolve: Resolve): PreparedBody {
  const vars = resolve(variables ?? '').trim();
  let parsed: unknown = undefined;
  if (vars) {
    try {
      parsed = JSON.parse(vars);
    } catch (e) {
      throw new ReqvynError('VALIDATION', 'GraphQL variables are not valid JSON.', { cause: e });
    }
  }
  return bufferBody(JSON.stringify(parsed === undefined ? { query: resolve(query) } : { query: resolve(query), variables: parsed }), 'application/json');
}
