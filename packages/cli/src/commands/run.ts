import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ReqvynError, formatDuration, slugify } from '@reqvyn/shared';
import type { Collection, Environment, TestResult } from '@reqvyn/core';
import { parseDotEnv } from '@reqvyn/environment-engine';
import { ScriptSandboxPool } from '@reqvyn/test-engine';
import {
  createVariableState,
  parseDataFile,
  renderReport,
  runCollection,
  runSucceeded,
  type ExecutorOptions,
  type ReportFormat,
  type RunReport,
  type RunResultEntry,
} from '@reqvyn/runner';
import { flag, int, list, str, type OptionSpec, type ParsedArgs } from '../args.js';
import { EXIT, painter, type CliIO, type Painter } from '../io.js';
import { EnvSecretVault } from '../vault.js';
import { findCollection, findEnvironment, findFolder, findRequest, findWorkspaceRoot, openWorkspace } from '../workspace.js';

export const RUN_OPTIONS: OptionSpec[] = [
  { name: 'workspace', alias: 'w', type: 'string', valueName: 'dir', description: 'Workspace folder (default: nearest folder containing .reqvyn)' },
  { name: 'collection', alias: 'c', type: 'string', valueName: 'name|id', description: 'Collection for "run request" / "run folder"' },
  { name: 'env', alias: 'e', type: 'string', valueName: 'name|id', description: 'Environment to use' },
  { name: 'data', alias: 'd', type: 'string', valueName: 'file', description: 'CSV/TSV/JSON data file; one iteration per row' },
  { name: 'iterations', alias: 'n', type: 'string', valueName: 'n', description: 'Number of iterations (ignored with --data)' },
  { name: 'delay', type: 'string', valueName: 'ms', description: 'Delay between requests' },
  { name: 'concurrency', type: 'string', valueName: 'n', description: 'Requests in parallel per iteration (default 1)' },
  { name: 'bail', type: 'flag', description: 'Stop at the first failed or errored request' },
  { name: 'skip', type: 'string', multiple: true, valueName: 'name|id', description: 'Skip requests (repeatable)' },
  { name: 'var', type: 'string', multiple: false, valueName: 'key=value', description: 'Runtime variable override (repeatable)' },
  { name: 'env-file', type: 'string', valueName: 'file', description: 'Load a .env file into the process environment ({{$env:X}}, REQVYN_SECRET_*)' },
  { name: 'secrets', type: 'string', valueName: 'file', description: 'JSON file with secret values (prefer REQVYN_SECRET_* variables)' },
  { name: 'report', alias: 'r', type: 'string', multiple: true, valueName: 'cli|json|html|junit', description: 'Reporters (default: cli); comma separated or repeated' },
  { name: 'out', alias: 'o', type: 'string', valueName: 'dir', description: 'Report output folder (default: ./reqvyn-reports)' },
  { name: 'timeout', type: 'string', valueName: 'ms', description: 'Default request timeout' },
  { name: 'proxy', type: 'string', valueName: 'url', description: 'HTTP(S) proxy for all requests' },
  { name: 'ca', type: 'string', multiple: true, valueName: 'file', description: 'Additional trusted CA certificate (PEM, repeatable)' },
  { name: 'insecure', type: 'flag', description: 'Disable TLS certificate verification (prints a warning)' },
  { name: 'no-scripts', type: 'flag', description: 'Do not execute pre-/post-request scripts' },
  { name: 'verbose', alias: 'v', type: 'flag', description: 'Print script console output and variable changes' },
  { name: 'silent', alias: 's', type: 'flag', description: 'Only print the summary' },
];

const KINDS = new Set(['collection', 'request', 'folder']);
const FILE_NAMES: Record<ReportFormat, string> = { json: 'reqvyn-report.json', html: 'reqvyn-report.html', junit: 'reqvyn-junit.xml' };

const abs = (cwd: string, p: string) => (isAbsolute(p) ? p : resolve(cwd, p));

async function readFileOrFail(path: string, what: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    throw new ReqvynError('NOT_FOUND', `${what} "${path}" could not be read.`);
  }
}

/** `--var a=1 --var b=2` → Map. The parser stores single values, so we collect them from argv directly. */
export function parseVars(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = a === '--var' ? argv[++i] : a.startsWith('--var=') ? a.slice(6) : undefined;
    if (value === undefined) continue;
    const eq = value.indexOf('=');
    if (eq <= 0) throw new ReqvynError('VALIDATION', `--var expects key=value, got "${value}".`);
    out.set(value.slice(0, eq), value.slice(eq + 1));
  }
  return out;
}

function printFailures(tests: TestResult[], p: Painter, indent: string, out: string[]): void {
  for (const t of tests) {
    if (t.passed) continue;
    out.push(`${indent}${p.red('✗')} ${t.name}${t.message ? p.dim(` – ${t.message}`) : ''}`);
    if (t.children) printFailures(t.children, p, `${indent}  `, out);
  }
}

export function formatResultLine(r: RunResultEntry, p: Painter, verbose: boolean): string {
  const method = r.response?.sentRequest.method ?? '';
  const lines: string[] = [];
  const icon = r.status === 'passed' ? p.green('✓') : r.status === 'skipped' ? p.dim('○') : p.red('✗');
  const status = r.response ? (r.response.status < 400 ? p.green(String(r.response.status)) : p.yellow(String(r.response.status))) : '';
  const time = r.response ? p.dim(formatDuration(r.response.timings.totalMs)) : '';
  lines.push(`  ${icon} ${p.bold(method.padEnd(6))} ${r.requestName} ${status} ${time}${r.status === 'skipped' ? p.dim(' skipped') : ''}`.trimEnd());
  if (r.error) lines.push(`      ${p.red(`${r.error.code}: ${r.error.message}`)}${r.error.hint ? p.dim(` (${r.error.hint})`) : ''}`);
  const passed = r.tests.filter((t) => t.passed).length;
  if (r.tests.length) lines.push(p.dim(`      ${passed}/${r.tests.length} tests passed`));
  printFailures(r.tests, p, '      ', lines);
  if (verbose) {
    for (const c of r.console) lines.push(p.dim(`      [${c.level}] ${c.message}`));
    for (const v of r.variableChanges) lines.push(p.dim(`      ${v.scope}.${v.key} = ${v.value}`));
  }
  return lines.join('\n');
}

export function formatSummary(report: RunReport, p: Painter): string {
  const s = report.summary;
  const parts = [
    p.green(`${s.passed} passed`),
    s.failed ? p.red(`${s.failed} failed`) : `${s.failed} failed`,
    s.errored ? p.red(`${s.errored} errored`) : `${s.errored} errored`,
    `${s.skipped} skipped`,
  ];
  const lines = [
    '',
    `${p.bold('Requests:')}   ${parts.join(', ')} (${s.total} total)`,
    `${p.bold('Assertions:')} ${s.assertions.passed} passed, ${s.assertions.failed ? p.red(`${s.assertions.failed} failed`) : '0 failed'}`,
    `${p.bold('Duration:')}   ${formatDuration(s.durationMs)}`,
  ];
  if (s.cancelled) lines.push(p.yellow('Run cancelled.'));
  return lines.join('\n');
}

interface Target {
  collection: Collection;
  folderId?: string;
  requestIds?: string[];
  label: string;
}

async function resolveTarget(args: ParsedArgs, store: Parameters<typeof findCollection>[0]): Promise<Target> {
  let [kind, name] = args.positionals;
  if (kind && !KINDS.has(kind)) {
    name = kind;
    kind = 'collection';
  }
  if (!name) throw new ReqvynError('VALIDATION', 'Missing target.', { hint: 'Usage: reqvyn run collection <name> | run request <name> | run folder <name> --collection <name>' });
  const collectionQuery = str(args, 'collection');
  if (kind === 'request') {
    const { collection, request } = await findRequest(store, name, collectionQuery);
    return { collection, requestIds: [request.id], label: `${collection.name} / ${request.name}` };
  }
  if (kind === 'folder') {
    if (collectionQuery) {
      const collection = await findCollection(store, collectionQuery);
      const folder = findFolder(collection, name);
      return { collection, folderId: folder.id, label: `${collection.name} / ${folder.name}` };
    }
    const hits: Target[] = [];
    for (const s of await store.listCollections()) {
      const c = await store.loadCollection(s.id);
      try {
        const f = findFolder(c, name);
        hits.push({ collection: c, folderId: f.id, label: `${c.name} / ${f.name}` });
      } catch {
        /* not in this collection */
      }
    }
    if (hits.length === 1) return hits[0]!;
    if (!hits.length) throw new ReqvynError('NOT_FOUND', `Folder "${name}" not found in any collection.`);
    throw new ReqvynError('VALIDATION', `Folder "${name}" exists in several collections.`, { hint: 'Add --collection <name>.' });
  }
  const collection = await findCollection(store, name);
  return { collection, label: collection.name };
}

export async function runCommand(args: ParsedArgs, argv: string[], io: CliIO): Promise<number> {
  const p = painter(io.color ?? false);
  const silent = flag(args, 'silent') ?? false;
  const verbose = flag(args, 'verbose') ?? false;
  const root = findWorkspaceRoot(io.cwd, str(args, 'workspace'));
  const { store } = await openWorkspace(root);
  try {
    const target = await resolveTarget(args, store);
    const problems = store.getProblems();
    for (const pr of problems) io.stderr(p.yellow(`warning: ${pr.file}: ${pr.message}\n`));

    const environments = await store.listEnvironments();
    const envQuery = str(args, 'env');
    const environment: Environment | null = envQuery ? await findEnvironment(store, envQuery) : null;
    const config = await store.loadConfig();

    // Process environment: real env + optional .env file (real env wins, like most CI tools).
    const processEnv: Record<string, string | undefined> = {};
    const envFile = str(args, 'env-file');
    if (envFile) for (const { key, value } of parseDotEnv(await readFileOrFail(abs(io.cwd, envFile), '.env file'))) processEnv[key] = value;
    Object.assign(processEnv, io.env);

    let secretsFile: Record<string, string> = {};
    const secretsPath = str(args, 'secrets');
    if (secretsPath) {
      const parsed: unknown = JSON.parse(await readFileOrFail(abs(io.cwd, secretsPath), 'Secrets file'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ReqvynError('VALIDATION', 'The secrets file must contain a JSON object of name → value.');
      secretsFile = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    }
    const vault = new EnvSecretVault(processEnv, secretsFile, new Map(environments.map((e) => [e.id, e.name])));

    const dataPath = str(args, 'data');
    const data = dataPath ? parseDataFile(dataPath, await readFileOrFail(abs(io.cwd, dataPath), 'Data file')) : undefined;
    if (data && !data.length) throw new ReqvynError('VALIDATION', `Data file "${dataPath}" contains no rows.`);

    const skipIds = list(args, 'skip').map((q) => {
      const r = target.collection.requests.find((x) => x.id === q || x.name.toLowerCase() === q.toLowerCase() || slugify(x.name) === slugify(q));
      if (!r) throw new ReqvynError('NOT_FOUND', `--skip: request "${q}" not found in "${target.collection.name}".`);
      return r.id;
    });

    const formats = list(args, 'report').map((f) => f.toLowerCase());
    for (const f of formats) if (!['cli', 'json', 'html', 'junit'].includes(f)) throw new ReqvynError('VALIDATION', `Unknown reporter "${f}".`, { hint: 'Use cli, json, html or junit.' });
    const fileFormats = formats.filter((f): f is ReportFormat => f !== 'cli');
    const printCli = !formats.length || formats.includes('cli');

    const insecure = flag(args, 'insecure') ?? false;
    if (insecure) io.stderr(p.yellow('warning: TLS certificate verification is DISABLED for this run (--insecure).\n'));
    const ca = await Promise.all(list(args, 'ca').map((f) => readFileOrFail(abs(io.cwd, f), 'CA certificate')));
    const proxy = str(args, 'proxy');
    const scriptsEnabled = !(flag(args, 'no-scripts') ?? false) && flag(args, 'scripts') !== false;

    const sandbox = scriptsEnabled ? new ScriptSandboxPool({ size: 2 }) : undefined;
    const exec: ExecutorOptions = {
      vault,
      sandbox,
      scripts: { enabled: scriptsEnabled },
      baseDir: root,
      processEnv,
      send: {
        timeoutMs: int(args, 'timeout', 1),
        proxy: proxy ? { url: proxy } : undefined,
        tls: { ...(insecure ? { verify: false } : {}), ...(ca.length ? { ca } : {}) },
        userAgent: 'REQVYN-CLI/0.1.0',
      },
    };

    const state = createVariableState();
    for (const [k, v] of parseVars(argv)) state.runtime.set(k, v);

    if (!silent) io.stdout(`${p.cyan(p.bold('REQVYN'))} ${p.dim('Send. Inspect. Repeat.')}\n${p.bold('Running')} ${target.label}${environment ? p.dim(` (env: ${environment.name})`) : ''}\n`);
    let lastIteration = 0;
    const iterationsTotal = data?.length ?? int(args, 'iterations', 1) ?? 1;
    let report: RunReport;
    try {
      report = await runCollection(
        {
          collection: target.collection,
          folderId: target.folderId,
          requestIds: target.requestIds,
          skip: skipIds,
          iterations: int(args, 'iterations', 1),
          delayMs: int(args, 'delay'),
          concurrency: int(args, 'concurrency', 1),
          stopOnFailure: flag(args, 'bail'),
          data,
          environment,
          workspace: config.variables,
          state,
          signal: io.signal,
          onProgress: (pr) => {
            if (!pr.result || silent || !printCli) return;
            if (iterationsTotal > 1 && pr.iteration !== lastIteration) {
              lastIteration = pr.iteration;
              io.stdout(p.dim(`\nIteration ${pr.iteration}/${pr.totalIterations}\n`));
            }
            io.stdout(`${formatResultLine(pr.result as RunResultEntry, p, verbose)}\n`);
          },
        },
        exec,
      );
    } finally {
      await sandbox?.dispose();
    }

    if (printCli || silent) io.stdout(`${formatSummary(report, p)}\n`);
    if (fileFormats.length) {
      const outDir = abs(io.cwd, str(args, 'out') ?? 'reqvyn-reports');
      await fs.mkdir(outDir, { recursive: true });
      for (const f of fileFormats) {
        const file = join(outDir, FILE_NAMES[f]);
        await fs.writeFile(file, renderReport(report, f), 'utf8');
        if (!silent) io.stdout(p.dim(`Report written: ${file}\n`));
      }
    }
    if (report.summary.cancelled) return EXIT.CANCELLED;
    return runSucceeded(report) ? EXIT.OK : EXIT.FAILED;
  } finally {
    store.dispose();
  }
}
