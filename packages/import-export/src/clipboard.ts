import { parseRequest, type Collection, type Environment, type HttpRequest } from '@reqvyn/core';
import { detectFormat, importText } from './detect.js';
import { exportNative, type NativeExportOptions } from './exporters/native.js';
import { parseCurl, splitCurlCommands } from './importers/curl.js';
import { sanitizeRequest, scanForSecrets, scanRequest, type SensitiveFinding } from './secrets.js';
import type { ImportFormat, ImportWarning } from './types.js';

/** Clipboard helpers: portable request JSON, collection JSON and paste detection. */

export interface PortableRequest {
  reqvyn: 'request';
  version: 1;
  request: HttpRequest;
}

/** Serialize a request for the clipboard. Secrets are blanked unless `includeSecrets` is set. */
export function requestToPortableJson(request: HttpRequest, opts: { includeSecrets?: boolean; indent?: number } = {}): string {
  const { request: clean } = sanitizeRequest(parseRequest(request), { includeSecrets: opts.includeSecrets === true });
  const doc: PortableRequest = { reqvyn: 'request', version: 1, request: { ...clean, parentId: null } };
  return JSON.stringify(doc, null, opts.indent ?? 2);
}

/** Serialize a collection (and optionally environments) as REQVYN native JSON. */
export function collectionToJson(collection: Collection, opts: NativeExportOptions = {}): string {
  return exportNative(collection, opts).text;
}

export type ClipboardKind = 'request' | 'collection' | 'environment' | 'unknown';

export interface ClipboardContent {
  kind: ClipboardKind;
  format: ImportFormat;
  /** Set when the clipboard holds a single request (portable JSON or a single cURL command). */
  request?: HttpRequest;
  collections: Collection[];
  environments: Environment[];
  warnings: ImportWarning[];
  /** Embedded credentials found in the pasted content. */
  secrets: SensitiveFinding[];
  error?: string;
}

const MAX_CLIPBOARD = 20 * 1024 * 1024;

/** Detect and parse pasted text (REQVYN JSON, cURL, Postman, OpenAPI, ...). Never throws. */
export function parseClipboard(text: string): ClipboardContent {
  const empty = (format: ImportFormat, error?: string): ClipboardContent => ({ kind: 'unknown', format, collections: [], environments: [], warnings: [], secrets: [], ...(error ? { error } : {}) });
  if (!text || !text.trim()) return empty('unknown');
  if (text.length > MAX_CLIPBOARD) return empty('unknown', 'Clipboard content is too large.');
  const format = detectFormat(text);
  if (format === 'unknown' || format === 'reqvyn-package') return empty(format);
  try {
    if (format === 'curl' && splitCurlCommands(text).length === 1) {
      const { request, warnings } = parseCurl(text);
      return { kind: 'request', format, request, collections: [], environments: [], warnings, secrets: scanRequest(request) };
    }
    const res = importText(text);
    const single = format === 'reqvyn-request' ? res.collections[0]?.requests[0] : undefined;
    const kind: ClipboardKind = single ? 'request' : res.collections.length ? 'collection' : res.environments.length ? 'environment' : 'unknown';
    return {
      kind,
      format,
      ...(single ? { request: single } : {}),
      collections: res.collections,
      environments: res.environments,
      warnings: res.warnings,
      secrets: scanForSecrets([...res.collections, ...res.environments]),
    };
  } catch (e) {
    return empty(format, e instanceof Error ? e.message : String(e));
  }
}
