import { promises as fs } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { ReqvynError } from '@reqvyn/shared';
import { exportCurlScript, exportNative, exportOpenApi, exportPostman, importFiles, buildPackage } from '@reqvyn/import-export';
import { flag, list, str, type OptionSpec, type ParsedArgs } from '../args.js';
import { EXIT, painter, type CliIO } from '../io.js';
import { findCollection, findWorkspaceRoot, openWorkspace } from '../workspace.js';

export const IMPORT_OPTIONS: OptionSpec[] = [
  { name: 'workspace', alias: 'w', type: 'string', valueName: 'dir', description: 'Workspace folder (must exist; defaults to the nearest folder containing .reqvyn)' },
  { name: 'dry-run', type: 'flag', description: 'Show what would be imported without writing anything' },
  { name: 'overwrite', type: 'flag', description: 'Replace collections/environments that already exist (same id)' },
];

export const EXPORT_OPTIONS: OptionSpec[] = [
  { name: 'workspace', alias: 'w', type: 'string', valueName: 'dir', description: 'Workspace folder' },
  { name: 'format', alias: 'f', type: 'string', valueName: 'reqvyn|package|postman|openapi|curl', description: 'Export format (default: reqvyn)' },
  { name: 'out', alias: 'o', type: 'string', valueName: 'file', description: 'Output file (default: stdout; required for package)' },
  { name: 'env', alias: 'e', type: 'string', multiple: true, valueName: 'name|id', description: 'Include environments (reqvyn/package formats)' },
];

export const LIST_OPTIONS: OptionSpec[] = [
  { name: 'workspace', alias: 'w', type: 'string', valueName: 'dir', description: 'Workspace folder' },
  { name: 'json', type: 'flag', description: 'Print as JSON' },
];

const abs = (cwd: string, p: string) => (isAbsolute(p) ? p : resolve(cwd, p));

export async function importCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const p = painter(io.color ?? false);
  const files = args.positionals;
  if (!files.length) throw new ReqvynError('VALIDATION', 'No files given.', { hint: 'Usage: reqvyn import <file...>' });
  const loaded = await Promise.all(
    files.map(async (f) => {
      try {
        return { name: basename(f), content: new Uint8Array(await fs.readFile(abs(io.cwd, f))) };
      } catch {
        throw new ReqvynError('NOT_FOUND', `File "${f}" could not be read.`);
      }
    }),
  );
  const result = importFiles(loaded);
  for (const w of result.warnings) io.stderr(`${w.code === 'failed' || w.code === 'unknown-file' ? p.red('error') : p.yellow('warning')} ${w.location ? `${w.location}: ` : ''}${w.message}\n`);
  if (!result.collections.length && !result.environments.length) {
    io.stderr(p.red('Nothing was imported.\n'));
    return EXIT.FAILED;
  }
  const dryRun = flag(args, 'dry-run') ?? false;
  const overwrite = flag(args, 'overwrite') ?? false;
  const root = findWorkspaceRoot(io.cwd, str(args, 'workspace'));
  const { store } = await openWorkspace(root, { create: !dryRun });
  let secretRows = 0;
  try {
    const existingCollections = new Set(dryRun ? [] : (await store.listCollections()).map((c) => c.id));
    const existingEnvs = new Set(dryRun ? [] : (await store.listEnvironments()).map((e) => e.id));
    for (const c of result.collections) {
      const exists = existingCollections.has(c.id);
      if (exists && !overwrite) {
        io.stdout(p.yellow(`skipped  collection "${c.name}" (already exists; use --overwrite)\n`));
        continue;
      }
      if (!dryRun) await store.saveCollection(c, { force: true });
      io.stdout(`${dryRun ? 'would import' : exists ? 'replaced' : p.green('imported')} collection "${c.name}" (${c.requests.length} requests, ${c.folders.length} folders)\n`);
    }
    for (const e of result.environments) {
      const exists = existingEnvs.has(e.id);
      if (exists && !overwrite) {
        io.stdout(p.yellow(`skipped  environment "${e.name}" (already exists; use --overwrite)\n`));
        continue;
      }
      secretRows += e.variables.filter((v) => v.secret && v.value).length;
      if (!dryRun) await store.saveEnvironment(e, { force: true });
      io.stdout(`${dryRun ? 'would import' : exists ? 'replaced' : p.green('imported')} environment "${e.name}" (${e.variables.length} variables)\n`);
    }
  } finally {
    store.dispose();
  }
  if (secretRows) {
    io.stderr(p.yellow(`note: ${secretRows} secret value(s) were not written to disk. Provide them at run time via REQVYN_SECRET_<NAME> or store them in VS Code.\n`));
  }
  if (!dryRun) io.stdout(p.dim(`Workspace: ${root}\n`));
  return EXIT.OK;
}

export async function exportCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const name = args.positionals[0];
  if (!name) throw new ReqvynError('VALIDATION', 'Missing collection.', { hint: 'Usage: reqvyn export <collection> [--format reqvyn|package|postman|openapi|curl] [--out file]' });
  const format = (str(args, 'format') ?? 'reqvyn').toLowerCase();
  const out = str(args, 'out');
  const root = findWorkspaceRoot(io.cwd, str(args, 'workspace'));
  const { store } = await openWorkspace(root);
  try {
    const collection = await findCollection(store, name);
    const envQueries = list(args, 'env');
    const allEnvs = await store.listEnvironments();
    const environments = envQueries.map((q) => {
      const e = allEnvs.find((x) => x.id === q || x.name.toLowerCase() === q.toLowerCase());
      if (!e) throw new ReqvynError('NOT_FOUND', `Environment "${q}" not found.`);
      return e;
    });
    let text: string | undefined;
    let bytes: Uint8Array | undefined;
    let warnings: Array<{ message: string; location?: string }> = [];
    switch (format) {
      case 'reqvyn': {
        const r = exportNative(collection, { environments });
        ({ text, warnings } = r);
        break;
      }
      case 'package': {
        if (!out) throw new ReqvynError('VALIDATION', 'The package format is binary; use --out <file.reqvyn>.');
        const r = buildPackage(collection, { environments, generator: 'REQVYN CLI' });
        bytes = r.bytes;
        warnings = r.removed.map((f) => ({ location: f.location, message: `${f.field}: value removed (${f.reason})` }));
        break;
      }
      case 'postman': {
        const r = exportPostman(collection);
        ({ text, warnings } = r);
        break;
      }
      case 'openapi': {
        const r = exportOpenApi(collection);
        ({ text, warnings } = r);
        break;
      }
      case 'curl': {
        const r = exportCurlScript(collection);
        ({ text, warnings } = r);
        break;
      }
      default:
        throw new ReqvynError('VALIDATION', `Unknown export format "${format}".`, { hint: 'Use reqvyn, package, postman, openapi or curl.' });
    }
    for (const w of warnings) io.stderr(`warning ${w.location ? `${w.location}: ` : ''}${w.message}\n`);
    if (out) {
      await fs.writeFile(abs(io.cwd, out), bytes ?? text ?? '');
      io.stderr(`Exported "${collection.name}" to ${abs(io.cwd, out)}\n`);
    } else io.stdout(text!.endsWith('\n') ? text! : `${text}\n`);
    return EXIT.OK;
  } finally {
    store.dispose();
  }
}

export async function listCommand(args: ParsedArgs, io: CliIO): Promise<number> {
  const p = painter(io.color ?? false);
  const root = findWorkspaceRoot(io.cwd, str(args, 'workspace'));
  const { store } = await openWorkspace(root);
  try {
    const collections = await store.listCollections();
    const environments = (await store.listEnvironments()).map((e) => ({ id: e.id, name: e.name, variables: e.variables.length }));
    if (flag(args, 'json')) {
      io.stdout(`${JSON.stringify({ workspace: root, collections, environments }, null, 2)}\n`);
      return EXIT.OK;
    }
    io.stdout(`${p.bold('Collections')}\n`);
    for (const c of collections) io.stdout(`  ${c.name} ${p.dim(`(${c.requestCount} requests, ${c.folderCount} folders) ${c.id}`)}\n`);
    if (!collections.length) io.stdout(p.dim('  (none)\n'));
    io.stdout(`${p.bold('Environments')}\n`);
    for (const e of environments) io.stdout(`  ${e.name} ${p.dim(`(${e.variables} variables) ${e.id}`)}\n`);
    if (!environments.length) io.stdout(p.dim('  (none)\n'));
    return EXIT.OK;
  } finally {
    store.dispose();
  }
}
