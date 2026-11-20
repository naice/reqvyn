import type { Collection, HttpRequest } from '@reqvyn/core';
import { generateCode } from '../codegen.js';
import type { ExportResult } from '../types.js';

export interface CurlExportOptions {
  /** Apply inherited headers/auth/settings from this collection. */
  collection?: Collection;
  /** One option per line (default true). */
  multiline?: boolean;
  /** Keep literal secrets (default false: placeholders such as <TOKEN>). */
  includeSecrets?: boolean;
}

/** Export a request as a POSIX-shell cURL command. `{{variables}}` are kept verbatim. */
export function exportCurl(request: HttpRequest, opts: CurlExportOptions = {}): ExportResult {
  const r = generateCode('curl', request, {
    ...(opts.collection ? { collection: opts.collection } : {}),
    multiline: opts.multiline !== false,
    includeSecrets: opts.includeSecrets === true,
  });
  return { text: r.code, warnings: r.warnings };
}

/** Export several requests (e.g. a whole collection) as a shell script of cURL commands. */
export function exportCurlScript(collection: Collection, opts: Omit<CurlExportOptions, 'collection'> = {}): ExportResult {
  const warnings: ExportResult['warnings'] = [];
  const parts = ['#!/bin/sh', `# ${collection.name.replace(/[\r\n]+/g, ' ')} (exported by REQVYN)`];
  for (const r of collection.requests) {
    const res = exportCurl(r, { ...opts, collection });
    parts.push('', `# ${r.name.replace(/[\r\n]+/g, ' ')}`, res.text);
    warnings.push(...res.warnings.map((w) => ({ ...w, location: w.location ?? r.name })));
  }
  return { text: `${parts.join('\n')}\n`, warnings };
}
