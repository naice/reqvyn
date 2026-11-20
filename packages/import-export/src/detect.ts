import { errorMessage, isReqvynError } from '@reqvyn/shared';
import { importBrunoFiles, importBrunoJson, isBrunoJson, looksLikeBru } from './importers/bruno.js';
import { importCurl } from './importers/curl.js';
import { importHoppscotch, importHoppscotchEnvironment, isHoppscotchCollection, isHoppscotchEnvironment } from './importers/hoppscotch.js';
import { importInsomnia, isInsomniaExport } from './importers/insomnia.js';
import { importOpenApi, isOpenApi, isSwagger2, parseSpecText, type OpenApiImportOptions } from './importers/openapi.js';
import { importPostmanCollection, importPostmanEnvironment, isPostmanCollection, isPostmanEnvironment } from './importers/postman.js';
import { importReqvyn, isReqvynCollection, isReqvynEnvironment, isReqvynRequest } from './importers/reqvyn.js';
import { importThunderCollection, importThunderEnvironment, isThunderCollection, isThunderEnvironment } from './importers/thunder.js';
import { looksLikeZip, readPackage } from './package.js';
import type { ZipLimits } from './zip.js';
import { emptyResult, type ImportFile, type ImportFormat, type ImportResult } from './types.js';
import { decodeText, importError, isObject, parseJsonSafe } from './util.js';

const CURL_RE = /^\s*(?:(?:#|rem\s|::)[^\n]*\n\s*)*curl(?:\.exe)?\s/i;

/** Detect the format of a parsed JSON/YAML document. */
export function detectDocumentFormat(doc: unknown): ImportFormat {
  if (isReqvynRequest(doc)) return 'reqvyn-request';
  if (isReqvynCollection(doc)) return 'reqvyn';
  if (isReqvynEnvironment(doc)) return 'reqvyn-environment';
  if (isPostmanCollection(doc)) return 'postman';
  if (isInsomniaExport(doc)) return 'insomnia';
  if (isThunderCollection(doc)) return 'thunder';
  if (isThunderEnvironment(doc)) return 'thunder-environment';
  if (isOpenApi(doc)) return 'openapi';
  if (isSwagger2(doc)) return 'swagger2';
  if (isBrunoJson(doc)) return 'bruno-json';
  if (isPostmanEnvironment(doc)) return 'postman-environment';
  if (isHoppscotchCollection(doc)) return 'hoppscotch';
  if (isHoppscotchEnvironment(doc)) return 'hoppscotch-environment';
  return 'unknown';
}

/**
 * Detect the format of an import file from its text (and optionally its name). Binary `.reqvyn`
 * packages are detected by name; pass bytes to {@link importFiles} to import them.
 */
export function detectFormat(text: string, fileName?: string): ImportFormat {
  const name = (fileName ?? '').toLowerCase();
  if (name.endsWith('.reqvyn') || text.startsWith('PK\u0003\u0004')) return 'reqvyn-package';
  const t = text.replace(/^\uFEFF/, '');
  const trimmed = t.trim();
  if (!trimmed) return 'unknown';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const doc = parseJsonSafe(trimmed);
    if (doc !== undefined) return detectDocumentFormat(doc);
  }
  if (name.endsWith('.bru') || looksLikeBru(t)) return 'bruno';
  if (CURL_RE.test(t)) return 'curl';
  if (name.endsWith('.yaml') || name.endsWith('.yml') || /^\s*(openapi|swagger)\s*:/m.test(t)) {
    try {
      const doc = parseSpecText(t);
      return isOpenApi(doc) ? 'openapi' : isSwagger2(doc) ? 'swagger2' : 'unknown';
    } catch {
      return 'unknown';
    }
  }
  return 'unknown';
}

export interface ImportOptions {
  /** Options for OpenAPI imports. */
  openapi?: Omit<OpenApiImportOptions, 'fileName'>;
  /** Limits applied to `.reqvyn` packages. */
  packageLimits?: Partial<ZipLimits>;
}

/** Import a single text document in any supported format. Throws ReqvynError('IMPORT') on failure. */
export function importText(text: string, fileName?: string, opts: ImportOptions = {}): ImportResult & { format: ImportFormat } {
  const format = detectFormat(text, fileName);
  const t = text.replace(/^\uFEFF/, '');
  const json = () => {
    const doc = parseJsonSafe(t.trim());
    if (doc === undefined) throw importError('The file is not valid JSON.');
    return doc;
  };
  const run = (): ImportResult => {
    switch (format) {
      case 'reqvyn':
      case 'reqvyn-environment':
      case 'reqvyn-request':
        return importReqvyn(json(), fileName);
      case 'postman':
        return importPostmanCollection(json(), fileName);
      case 'postman-environment':
        return importPostmanEnvironment(json());
      case 'thunder':
        return importThunderCollection(json(), fileName);
      case 'thunder-environment':
        return importThunderEnvironment(json());
      case 'insomnia':
        return importInsomnia(json(), fileName);
      case 'bruno':
        return importBrunoFiles([{ name: fileName ?? 'request.bru', content: t }]);
      case 'bruno-json':
        return importBrunoJson(json(), fileName);
      case 'hoppscotch':
        return importHoppscotch(json(), fileName);
      case 'hoppscotch-environment':
        return importHoppscotchEnvironment(json());
      case 'openapi':
      case 'swagger2':
        return importOpenApi(parseSpecText(t), { ...opts.openapi, ...(fileName ? { fileName } : {}) });
      case 'curl':
        return importCurl(t, fileName);
      case 'reqvyn-package':
        throw importError('REQVYN packages are binary; import them as bytes with importFiles() or readPackage().');
      default:
        throw importError(
          `Unrecognized file format${fileName ? ` ("${fileName}")` : ''}.`,
          'Supported: REQVYN, Postman v2.x collections/environments, Thunder Client, Insomnia v4, Bruno, Hoppscotch, OpenAPI 3.x (JSON/YAML) and cURL.',
        );
    }
  };
  return { ...run(), format };
}

function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p;
}

function dirname(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.join('/');
}

function isBrunoConfig(file: ImportFile): boolean {
  if (basename(file.name).toLowerCase() !== 'bruno.json') return false;
  const doc = parseJsonSafe(decodeText(file.content));
  return isObject(doc) && !Array.isArray(doc.items) && (doc.type === 'collection' || typeof doc.version === 'string');
}

/**
 * Import several files at once (multi-select or a dropped folder). Bruno `.bru` files are grouped
 * into collections by their `bruno.json` root (or their top-level directory); `.reqvyn` packages
 * are read as packages. A file that fails to import becomes a `failed` warning instead of aborting
 * the whole import.
 */
export function importFiles(files: ImportFile[], opts: ImportOptions = {}): ImportResult {
  const out = emptyResult();
  const roots = files.filter(isBrunoConfig).map((f) => dirname(f.name));
  const groups = new Map<string, ImportFile[]>();
  const rest: ImportFile[] = [];
  for (const f of files) {
    const base = basename(f.name).toLowerCase();
    const path = f.name.replace(/\\/g, '/');
    const root = roots
      .filter((r) => r === '' || path.startsWith(`${r}/`))
      .sort((a, b) => b.length - a.length)[0];
    const isBru = base.endsWith('.bru') || isBrunoConfig(f);
    if (root !== undefined && (isBru || base === '.env')) {
      const key = `root:${root}`;
      groups.set(key, [...(groups.get(key) ?? []), f]);
    } else if (base.endsWith('.bru')) {
      const top = path.includes('/') ? path.split('/')[0] ?? '' : '';
      const key = `dir:${top}`;
      groups.set(key, [...(groups.get(key) ?? []), f]);
    } else rest.push(f);
  }
  const record = (name: string, fn: () => ImportResult) => {
    try {
      const r = fn();
      out.collections.push(...r.collections);
      out.environments.push(...r.environments);
      out.warnings.push(...r.warnings.map((w) => (w.location ? w : { ...w, location: name })));
    } catch (e) {
      const text = (() => {
        try {
          return decodeText(files.find((f) => f.name === name)?.content ?? '');
        } catch {
          return '';
        }
      })();
      const format = detectFormat(text.slice(0, 2_000_000), name);
      out.warnings.push({
        format,
        code: format === 'unknown' ? 'unknown-file' : 'failed',
        message: `${name}: ${isReqvynError(e) ? e.message : errorMessage(e)}${isReqvynError(e) && e.hint ? ` ${e.hint}` : ''}`,
        location: name,
      });
    }
  };
  for (const [key, group] of groups) record(group.length === 1 ? (group[0]?.name ?? key) : key.replace(/^(root|dir):/, '') || 'Bruno files', () => importBrunoFiles(group));
  for (const f of rest) {
    const isPackage = f.name.toLowerCase().endsWith('.reqvyn') || (f.content instanceof Uint8Array && looksLikeZip(f.content));
    if (isPackage) {
      record(f.name, () => {
        if (typeof f.content === 'string') throw importError('A REQVYN package must be provided as bytes.');
        const pkg = readPackage(f.content, opts.packageLimits);
        return { collections: [pkg.collection], environments: pkg.environments, warnings: pkg.warnings };
      });
    } else record(f.name, () => importText(decodeText(f.content), f.name, opts));
  }
  return out;
}
