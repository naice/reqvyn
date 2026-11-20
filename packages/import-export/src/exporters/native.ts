import { parseCollection, parseEnvironment, type Collection, type Environment } from '@reqvyn/core';
import { environmentTemplate, sanitizeCollection, type SensitiveFinding } from '../secrets.js';
import type { ExportResult, ExportWarning } from '../types.js';

/** REQVYN native single-file JSON export (`{reqvyn: 'collection', version: 1, collection, environments}`). */

export interface NativeExportOptions {
  environments?: Environment[];
  includeSecrets?: boolean;
  includeEnvironmentValues?: boolean;
  redactSensitiveHeaders?: boolean;
  /** Pretty-print indentation (default 2, 0 for compact). */
  indent?: number;
}

export interface NativeDocument {
  reqvyn: 'collection';
  version: 1;
  collection: Collection;
  environments?: Environment[];
}

export function exportNative(collectionIn: Collection, opts: NativeExportOptions = {}): ExportResult<NativeDocument> & { removed: SensitiveFinding[] } {
  const { collection, removed } = sanitizeCollection(parseCollection(collectionIn), {
    includeSecrets: opts.includeSecrets === true,
    redactSensitiveHeaders: opts.redactSensitiveHeaders,
  });
  const environments = (opts.environments ?? []).map((e) => {
    const t = environmentTemplate(parseEnvironment(e), { includeSecrets: opts.includeSecrets === true, includeEnvironmentValues: opts.includeEnvironmentValues === true });
    removed.push(...t.removed);
    return t.environment;
  });
  const doc: NativeDocument = { reqvyn: 'collection', version: 1, collection, ...(environments.length ? { environments } : {}) };
  const warnings: ExportWarning[] = removed.length ? [{ code: 'secret', message: `${removed.length} secret value(s) were blanked.` }] : [];
  return { text: JSON.stringify(doc, null, opts.indent ?? 2), data: doc, warnings, removed };
}
