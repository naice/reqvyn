import { createCollection, parseCollection, parseEnvironment, parseRequest, type Collection } from '@reqvyn/core';
import { isReqvynError } from '@reqvyn/shared';
import { scanForSecrets } from '../secrets.js';
import type { ImportFormat, ImportResult } from '../types.js';
import { Warnings, importError, isObject } from '../util.js';

/**
 * REQVYN native JSON: a full collection document (`collection.json` with folders/requests), an
 * environment, a clipboard/portable wrapper (`{reqvyn: 'request' | 'collection' | 'environment'}`).
 */

export function isReqvynCollection(doc: unknown): boolean {
  if (!isObject(doc)) return false;
  if (doc.reqvyn === 'collection' && isObject(doc.collection)) return true;
  return typeof doc.schemaVersion === 'number' && typeof doc.id === 'string' && typeof doc.name === 'string' && (Array.isArray(doc.requests) || Array.isArray(doc.folders));
}

export function isReqvynEnvironment(doc: unknown): boolean {
  if (!isObject(doc)) return false;
  if (doc.reqvyn === 'environment' && isObject(doc.environment)) return true;
  return typeof doc.schemaVersion === 'number' && typeof doc.id === 'string' && typeof doc.name === 'string' && Array.isArray(doc.variables) && !('requests' in doc) && !('folders' in doc) && !('auth' in doc);
}

export function isReqvynRequest(doc: unknown): boolean {
  return isObject(doc) && doc.reqvyn === 'request' && isObject(doc.request);
}

function checkVersion(doc: Record<string, unknown>, format: ImportFormat): void {
  if (typeof doc.version === 'number' && doc.version > 1)
    throw importError(`This ${format} document uses wrapper version ${doc.version}, which is newer than supported.`, 'Update REQVYN to import it.');
}

function validated<T>(fn: () => T, what: string): T {
  try {
    return fn();
  } catch (e) {
    if (isReqvynError(e)) throw importError(`Invalid REQVYN ${what}: ${e.message}`, e.hint, e);
    throw e;
  }
}

function secretWarnings(w: Warnings, items: Parameters<typeof scanForSecrets>[0]): void {
  const findings = scanForSecrets(items);
  if (findings.length)
    w.add(
      'secret',
      `The imported data contains ${findings.length} embedded credential(s) (${[...new Set(findings.map((f) => f.field))].slice(0, 5).join(', ')}). Consider moving them to secret variables.`,
    );
}

export function importReqvyn(doc: unknown, fileName?: string): ImportResult {
  if (!isObject(doc)) throw importError('Not a REQVYN document.');
  if (isReqvynRequest(doc)) {
    const w = new Warnings('reqvyn-request');
    checkVersion(doc, 'reqvyn-request');
    const request = validated(() => parseRequest(doc.request), 'request');
    const collection: Collection = validated(
      () =>
        parseCollection(
          createCollection({
            name: request.name || 'Imported request',
            requests: [{ ...request, parentId: null, sortKey: 0 }],
            meta: { source: { type: 'reqvyn', ...(fileName ? { location: fileName } : {}) } },
          }),
        ),
      'request',
    );
    secretWarnings(w, collection);
    return { collections: [collection], environments: [], warnings: w.list };
  }
  if (isReqvynEnvironment(doc)) {
    const w = new Warnings('reqvyn-environment');
    checkVersion(doc, 'reqvyn-environment');
    const environment = validated(() => parseEnvironment(doc.reqvyn === 'environment' ? doc.environment : doc), 'environment');
    secretWarnings(w, environment);
    return { collections: [], environments: [environment], warnings: w.list };
  }
  if (isReqvynCollection(doc)) {
    const w = new Warnings('reqvyn');
    checkVersion(doc, 'reqvyn');
    const raw = doc.reqvyn === 'collection' ? doc.collection : doc;
    const collection = validated(() => parseCollection(raw), 'collection');
    const folderIds = new Set(collection.folders.map((f) => f.id));
    for (const item of [...collection.folders, ...collection.requests]) {
      if (item.parentId && !folderIds.has(item.parentId)) {
        w.add('converted', `"${item.name}" referenced a missing folder and was moved to the root.`, item.name, 'parentId');
        item.parentId = null;
      }
    }
    const environments =
      doc.reqvyn === 'collection' && Array.isArray(doc.environments) ? doc.environments.map((e) => validated(() => parseEnvironment(e), 'environment')) : [];
    secretWarnings(w, [collection, ...environments]);
    return { collections: [collection], environments, warnings: w.list };
  }
  throw importError('Not a REQVYN collection, environment or request document.');
}
