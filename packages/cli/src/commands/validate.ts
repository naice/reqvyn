import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Script } from 'node:vm';
import { errorMessage } from '@reqvyn/shared';
import { ancestorFolders, type Collection, type Environment, type HttpRequest, type KeyValue } from '@reqvyn/core';
import { flag, str, type OptionSpec, type ParsedArgs } from '../args.js';
import { EXIT, painter, type CliIO } from '../io.js';
import { findWorkspaceRoot, openWorkspace } from '../workspace.js';

export const VALIDATE_OPTIONS: OptionSpec[] = [
  { name: 'workspace', alias: 'w', type: 'string', valueName: 'dir', description: 'Workspace folder' },
  { name: 'strict', type: 'flag', description: 'Treat warnings as errors' },
  { name: 'json', type: 'flag', description: 'Print findings as JSON' },
];

export interface Finding {
  level: 'error' | 'warning';
  location: string;
  message: string;
}

const TEMPLATE = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** Variable names referenced through {{name}} (dynamic variables like {{$guid}} and {{$secret:x}} are excluded). */
export function referencedVariables(value: unknown): Set<string> {
  const out = new Set<string>();
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const m of text.matchAll(TEMPLATE)) if (!m[1]!.startsWith('$')) out.add(m[1]!);
  return out;
}

/**
 * Compile (never execute) a script to report syntax errors. Scripts run as the body of an async function,
 * so the same wrapper is used here.
 */
export function scriptSyntaxError(code: string): string | undefined {
  if (!code.trim()) return undefined;
  try {
    new Script(`(async function () {\n${code}\n})`, { filename: 'script.js', lineOffset: -1 });
    return undefined;
  } catch (e) {
    return errorMessage(e);
  }
}

const keys = (rows: KeyValue[] | undefined) => (rows ?? []).filter((r) => r.enabled !== false).map((r) => r.key);

/** Static checks over a collection: scripts, structure, missing files and undefined variables. */
export function validateCollection(c: Collection, opts: { environments: Environment[]; workspaceVariables: KeyValue[]; baseDir: string }): Finding[] {
  const findings: Finding[] = [];
  const folderIds = new Set(c.folders.map((f) => f.id));
  const defined = new Set<string>([...keys(c.variables), ...keys(opts.workspaceVariables), ...opts.environments.flatMap((e) => keys(e.variables))]);
  // Variables produced during a run (extractions and scripts) are defined too.
  for (const r of c.requests) for (const x of r.extractions ?? []) defined.add(x.variable);
  const allScripts = [c.scripts, ...c.folders.map((f) => f.scripts), ...c.requests.map((r) => r.scripts)];
  for (const s of allScripts) {
    for (const m of `${s?.pre ?? ''}\n${s?.post ?? ''}`.matchAll(/variables\.set\(\s*['"`]([^'"`]+)['"`]/g)) defined.add(m[1]!);
  }

  const checkScripts = (where: string, s: { pre: string; post: string } | undefined) => {
    for (const phase of ['pre', 'post'] as const) {
      const err = s ? scriptSyntaxError(s[phase]) : undefined;
      if (err) findings.push({ level: 'error', location: `${where} (${phase}-request script)`, message: `Syntax error: ${err}` });
    }
  };
  checkScripts(c.name, c.scripts);
  for (const f of c.folders) {
    const where = `${c.name} / ${[...ancestorFolders(c, f.parentId).map((a) => a.name), f.name].join(' / ')}`;
    if (f.parentId && !folderIds.has(f.parentId)) findings.push({ level: 'warning', location: where, message: 'Parent folder does not exist; the folder is shown at the root.' });
    checkScripts(where, f.scripts);
  }
  const requestLocation = (r: HttpRequest) => `${c.name} / ${[...ancestorFolders(c, r.parentId).map((a) => a.name), r.name].join(' / ')}`;
  for (const r of c.requests) {
    const where = requestLocation(r);
    if (r.parentId && !folderIds.has(r.parentId)) findings.push({ level: 'warning', location: where, message: 'Parent folder does not exist; the request is shown at the root.' });
    if (!r.url.trim()) findings.push({ level: 'error', location: where, message: 'The request has no URL.' });
    checkScripts(where, r.scripts);
    if (r.body.mode === 'binary' && r.body.filePath && !/\{\{/.test(r.body.filePath)) {
      const p = isAbsolute(r.body.filePath) ? r.body.filePath : resolve(opts.baseDir, r.body.filePath);
      if (!existsSync(p)) findings.push({ level: 'warning', location: where, message: `Body file not found: ${r.body.filePath}` });
    }
    const local = new Set([...keys(r.variables), ...ancestorFolders(c, r.parentId).flatMap((f) => keys(f.variables))]);
    const { scripts: _s, ...withoutScripts } = r;
    for (const name of referencedVariables(withoutScripts)) {
      if (!defined.has(name) && !local.has(name)) findings.push({ level: 'warning', location: where, message: `Variable {{${name}}} is not defined in any scope.` });
    }
  }
  return findings;
}

export async function validateCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const p = painter(io.color ?? false);
  const root = findWorkspaceRoot(io.cwd, str(args, 'workspace'));
  const { store } = await openWorkspace(root);
  try {
    const findings: Finding[] = [];
    const summaries = await store.listCollections();
    const environments = await store.listEnvironments();
    const config = await store.loadConfig();
    for (const s of summaries) {
      try {
        const c = await store.loadCollection(s.id);
        findings.push(...validateCollection(c, { environments, workspaceVariables: config.variables, baseDir: root }));
      } catch (e) {
        findings.push({ level: 'error', location: s.name, message: errorMessage(e) });
      }
    }
    for (const pr of store.getProblems()) findings.push({ level: 'error', location: pr.file, message: pr.message });

    const errors = findings.filter((f) => f.level === 'error').length;
    const warnings = findings.length - errors;
    if (flag(args, 'json')) {
      io.stdout(`${JSON.stringify({ collections: summaries.length, environments: environments.length, errors, warnings, findings }, null, 2)}\n`);
    } else {
      for (const f of findings) io.stdout(`${f.level === 'error' ? p.red('error  ') : p.yellow('warning')} ${f.location}: ${f.message}\n`);
      io.stdout(`${findings.length ? '\n' : ''}${summaries.length} collection(s), ${environments.length} environment(s): ${errors ? p.red(`${errors} error(s)`) : p.green('0 errors')}, ${warnings} warning(s)\n`);
    }
    return errors || (warnings && flag(args, 'strict')) ? EXIT.FAILED : EXIT.OK;
  } finally {
    store.dispose();
  }
}
