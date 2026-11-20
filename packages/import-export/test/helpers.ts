import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { parseCollection, parseEnvironment, type Collection, type HttpRequest } from '@reqvyn/core';
import type { ImportFile, ImportResult } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, 'fixtures');

export function fixture(path: string): string {
  return readFileSync(join(FIXTURES, path), 'utf8');
}

export function fixtureJson(path: string): unknown {
  return JSON.parse(fixture(path)) as unknown;
}

/** All files under a fixture directory as ImportFiles (names relative to `fixtures/<base>`'s parent). */
export function fixtureFiles(dir: string, prefix = dir.split('/').pop() ?? dir): ImportFile[] {
  const root = join(FIXTURES, dir);
  const out: ImportFile[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ name: `${prefix}/${relative(root, p).replace(/\\/g, '/')}`, content: readFileSync(p) });
    }
  };
  walk(root);
  return out;
}

/** Every collection/environment in an import result must pass the core validators. */
export function expectValid(result: ImportResult): void {
  for (const c of result.collections) expect(() => parseCollection(c)).not.toThrow();
  for (const e of result.environments) expect(() => parseEnvironment(e)).not.toThrow();
}

export function byName(c: Collection, name: string): HttpRequest {
  const r = c.requests.find((x) => x.name === name);
  if (!r) throw new Error(`Request "${name}" not found in ${c.requests.map((x) => x.name).join(', ')}`);
  return r;
}

export function folderName(c: Collection, r: HttpRequest): string | undefined {
  return c.folders.find((f) => f.id === r.parentId)?.name;
}

export function kvMap(list: Array<{ key: string; value: string; enabled?: boolean }>): Record<string, string> {
  return Object.fromEntries(list.filter((x) => x.enabled !== false).map((x) => [x.key, x.value]));
}
