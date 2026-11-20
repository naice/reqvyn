import type { Collection, Environment } from '@reqvyn/core';

/** Formats understood by the importer. */
export type ImportFormat =
  | 'reqvyn'
  | 'reqvyn-environment'
  | 'reqvyn-request'
  | 'reqvyn-package'
  | 'postman'
  | 'postman-environment'
  | 'thunder'
  | 'thunder-environment'
  | 'insomnia'
  | 'bruno'
  | 'bruno-json'
  | 'hoppscotch'
  | 'hoppscotch-environment'
  | 'openapi'
  | 'swagger2'
  | 'curl'
  | 'unknown';

export type WarningCode =
  /** A field of the source format has no REQVYN equivalent and was not imported. */
  | 'unsupported-field'
  /** A whole feature (auth type, body type, request kind) is not supported. */
  | 'unsupported-feature'
  /** Scripts were imported verbatim but use another tool's scripting API. */
  | 'script-needs-adaptation'
  /** A value was converted in a lossy or opinionated way. */
  | 'converted'
  /** The import contains a setting that weakens security (e.g. TLS verification disabled). */
  | 'insecure'
  /** Embedded secret material was detected or removed. */
  | 'secret'
  /** A file could not be imported. */
  | 'failed'
  /** A file inside a package or a folder import was not recognized. */
  | 'unknown-file'
  /** Informational notice. */
  | 'info';

export interface ImportWarning {
  format: ImportFormat;
  code: WarningCode;
  message: string;
  /** Human readable location, e.g. "Users API / Users / Get user" or a file name. */
  location?: string;
  /** Source field name (e.g. "protocolProfileBehavior", "auth.hawk"). */
  field?: string;
}

export interface ImportResult {
  collections: Collection[];
  environments: Environment[];
  warnings: ImportWarning[];
}

export interface ImportFile {
  name: string;
  content: string | Uint8Array;
}

export interface ExportWarning {
  code: WarningCode;
  message: string;
  location?: string;
  field?: string;
}

export interface ExportResult<T = unknown> {
  /** Serialized output (JSON text, shell command, ...). */
  text: string;
  /** Structured output where meaningful (parsed JSON document). */
  data?: T;
  warnings: ExportWarning[];
}

export function emptyResult(): ImportResult {
  return { collections: [], environments: [], warnings: [] };
}

export function mergeResults(results: ImportResult[]): ImportResult {
  const out = emptyResult();
  for (const r of results) {
    out.collections.push(...r.collections);
    out.environments.push(...r.environments);
    out.warnings.push(...r.warnings);
  }
  return out;
}
