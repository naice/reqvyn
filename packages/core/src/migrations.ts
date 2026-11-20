import { ReqvynError } from '@reqvyn/shared';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { emptyGroup } from './factories.js';
import {
  CollectionInfoSchema,
  CollectionSchema,
  EnvironmentSchema,
  FolderSchema,
  HttpRequestSchema,
  SCHEMA_VERSION,
  WorkspaceConfigSchema,
  type Collection,
  type CollectionInfo,
  type Environment,
  type Folder,
  type HttpRequest,
  type WorkspaceConfig,
} from './models.js';

/**
 * Schema migrations. Each migration upgrades a raw JSON document from version N to N+1.
 * Documents without a `schemaVersion` are treated as version 0 (pre-release drafts).
 * Migrations operate on plain JSON so they can run before validation.
 */
type Raw = Record<string, unknown>;
type Migration = (doc: Raw) => Raw;

const collectionMigrations: Record<number, Migration> = {
  // v0 -> v1: early drafts stored `items` as a nested tree; flatten into folders/requests with parentId.
  0: (doc) => {
    if (!Array.isArray(doc.items)) return { ...doc, schemaVersion: 1 };
    const folders: Raw[] = [];
    const requests: Raw[] = [];
    const walk = (items: Raw[], parentId: string | null) => {
      items.forEach((it, idx) => {
        if (Array.isArray(it.items)) {
          const { items: children, ...rest } = it;
          folders.push({ ...rest, parentId, sortKey: idx });
          walk(children as Raw[], rest.id as string);
        } else {
          requests.push({ ...it, parentId, sortKey: idx });
        }
      });
    };
    walk(doc.items as Raw[], null);
    const { items: _items, ...rest } = doc;
    return { ...rest, folders: [...((doc.folders as Raw[]) ?? []), ...folders], requests: [...((doc.requests as Raw[]) ?? []), ...requests], schemaVersion: 1 };
  },
};

export function migrateDocument(doc: Raw, migrations: Record<number, Migration> = collectionMigrations): { doc: Raw; migrated: boolean; fromVersion: number } {
  const fromVersion = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 0;
  if (fromVersion > SCHEMA_VERSION) {
    throw new ReqvynError('VALIDATION', `Document schema version ${fromVersion} is newer than supported version ${SCHEMA_VERSION}. Please update REQVYN.`);
  }
  let current = doc;
  for (let v = fromVersion; v < SCHEMA_VERSION; v++) {
    const m = migrations[v];
    current = m ? m(current) : { ...current, schemaVersion: v + 1 };
  }
  return { doc: current, migrated: fromVersion !== SCHEMA_VERSION, fromVersion };
}

function formatZodError(e: ZodError, label: string): ReqvynError {
  const issues = e.issues.slice(0, 5).map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
  return new ReqvynError('VALIDATION', `Invalid ${label}: ${issues.join('; ')}`, { details: { issues: e.issues } });
}

export function validate<S extends ZodTypeAny>(schema: S, data: unknown, label: string): z.output<S> {
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof ZodError) throw formatZodError(e, label);
    throw e;
  }
}

function withTests<T extends { tests?: unknown }>(x: T): T & { tests: ReturnType<typeof emptyGroup> } {
  return { ...x, tests: (x.tests as ReturnType<typeof emptyGroup> | undefined) ?? emptyGroup() };
}

export function parseRequest(data: unknown): HttpRequest {
  return withTests(validate(HttpRequestSchema, data, 'request')) as HttpRequest;
}

export function parseFolder(data: unknown): Folder {
  return withTests(validate(FolderSchema, data, 'folder')) as Folder;
}

export function parseCollectionInfo(data: unknown): CollectionInfo {
  const { doc } = migrateDocument((data ?? {}) as Raw);
  const { folders: _f, requests: _r, ...info } = doc;
  return withTests(validate(CollectionInfoSchema, info, 'collection')) as CollectionInfo;
}

export function parseCollection(data: unknown): Collection {
  const { doc } = migrateDocument((data ?? {}) as Raw);
  const parsed = validate(CollectionSchema, doc, 'collection');
  return {
    ...withTests(parsed),
    folders: parsed.folders.map((f) => withTests(f) as Folder),
    requests: parsed.requests.map((r) => withTests(r) as HttpRequest),
  } as Collection;
}

export function parseEnvironment(data: unknown): Environment {
  const { doc } = migrateDocument((data ?? {}) as Raw, {});
  return validate(EnvironmentSchema, doc, 'environment');
}

export function parseWorkspaceConfig(data: unknown): WorkspaceConfig {
  const { doc } = migrateDocument((data ?? {}) as Raw, {});
  return validate(WorkspaceConfigSchema, doc, 'workspace config');
}
