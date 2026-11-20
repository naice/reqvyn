import { ReqvynError, errorMessage, isReqvynError } from '@reqvyn/shared';
import { formatOptions, list, flag, parseArgs, str, type OptionSpec } from './args.js';
import { EXIT, painter, type CliIO } from './io.js';
import { RUN_OPTIONS, runCommand } from './commands/run.js';
import { VALIDATE_OPTIONS, validateCommand } from './commands/validate.js';
import { EXPORT_OPTIONS, IMPORT_OPTIONS, LIST_OPTIONS, exportCommand, importCommand, listCommand } from './commands/manage.js';
import { McpServer } from './mcp.js';
import { EnvSecretVault } from './vault.js';
import { findWorkspaceRoot, openWorkspace } from './workspace.js';

export const CLI_VERSION = '0.1.0';

export const MCP_OPTIONS: OptionSpec[] = [
  { name: 'workspace', alias: 'w', type: 'string', valueName: 'dir', description: 'Workspace folder' },
  { name: 'enable', type: 'flag', description: 'Required: confirms that the MCP server should start (disabled by default)' },
  { name: 'allow-write', type: 'flag', description: 'Allow creating/modifying requests and generating collections' },
  { name: 'allow-network', type: 'flag', description: 'Allow running requests (run_tests)' },
  { name: 'allow-host', type: 'string', multiple: true, valueName: 'host', description: 'Restrict network access to these hosts (*.example.com supported)' },
];

const COMMANDS: Record<string, { summary: string; usage: string; options: OptionSpec[] }> = {
  run: { summary: 'Run a collection, folder or request headlessly', usage: 'reqvyn run [collection|folder|request] <name|id> [options]', options: RUN_OPTIONS },
  validate: { summary: 'Check collections for errors (syntax, missing files, undefined variables)', usage: 'reqvyn validate [options]', options: VALIDATE_OPTIONS },
  import: { summary: 'Import Postman, Insomnia, Bruno, Hoppscotch, Thunder Client, OpenAPI, cURL or REQVYN files', usage: 'reqvyn import <file...> [options]', options: IMPORT_OPTIONS },
  export: { summary: 'Export a collection', usage: 'reqvyn export <collection> [options]', options: EXPORT_OPTIONS },
  list: { summary: 'List collections and environments', usage: 'reqvyn list [options]', options: LIST_OPTIONS },
  mcp: { summary: 'Start the optional MCP server on stdio (disabled unless --enable is given)', usage: 'reqvyn mcp --enable [--allow-write] [--allow-network]', options: MCP_OPTIONS },
};

export function helpText(command?: string): string {
  const c = command ? COMMANDS[command] : undefined;
  if (c) return `${c.summary}\n\nUsage: ${c.usage}\n\nOptions:\n${formatOptions(c.options)}\n`;
  const w = Math.max(...Object.keys(COMMANDS).map((k) => k.length)) + 2;
  return [
    `REQVYN CLI ${CLI_VERSION} – Send. Inspect. Repeat.`,
    '',
    'Usage: reqvyn <command> [options]',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(([k, v]) => `  ${k.padEnd(w)}${v.summary}`),
    `  ${'help'.padEnd(w)}Show help for a command`,
    '',
    'Secrets are read from environment variables named REQVYN_SECRET_<NAME>.',
    'Exit codes: 0 success, 1 failed tests/requests or validation errors, 2 usage/configuration error, 130 cancelled.',
    '',
  ].join('\n');
}

async function mcpCommand(argv: string[], io: CliIO, streams?: { input: NodeJS.ReadableStream; output: (line: string) => void }): Promise<number> {
  const args = parseArgs(argv, MCP_OPTIONS);
  if (!flag(args, 'enable') && io.env.REQVYN_MCP_ENABLED !== '1') {
    io.stderr('The REQVYN MCP server is disabled by default. Start it with "reqvyn mcp --enable" (or REQVYN_MCP_ENABLED=1).\n');
    return EXIT.USAGE;
  }
  if (!streams) throw new ReqvynError('INTERNAL', 'No stdio streams available.');
  const root = findWorkspaceRoot(io.cwd, str(args, 'workspace'));
  const { store } = await openWorkspace(root);
  const policy = { allowWrite: flag(args, 'allow-write') ?? false, allowNetwork: flag(args, 'allow-network') ?? false, allowedHosts: list(args, 'allow-host') };
  io.stderr(`REQVYN MCP server – workspace ${root} – write: ${policy.allowWrite ? 'on' : 'off'}, network: ${policy.allowNetwork ? 'on' : 'off'}\n`);
  const environments = await store.listEnvironments();
  const server = new McpServer({
    store,
    policy,
    vault: new EnvSecretVault(io.env, {}, new Map(environments.map((e) => [e.id, e.name]))),
    exec: { scripts: { enabled: false }, baseDir: root },
  });
  try {
    await server.serve(streams.input, streams.output);
  } finally {
    store.dispose();
  }
  return EXIT.OK;
}

/** CLI entry point. Never calls process.exit – returns the exit code instead (testable). */
export async function main(argv: string[], io: CliIO, streams?: { input: NodeJS.ReadableStream; output: (line: string) => void }): Promise<number> {
  const p = painter(io.color ?? false);
  const [command, ...rest] = argv;
  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      io.stdout(helpText(rest[0]));
      return EXIT.OK;
    }
    if (command === '--version' || command === '-V' || command === 'version') {
      io.stdout(`${CLI_VERSION}\n`);
      return EXIT.OK;
    }
    const spec = COMMANDS[command];
    if (!spec) throw new ReqvynError('VALIDATION', `Unknown command "${command}".`, { hint: 'Run "reqvyn help".' });
    if (rest.includes('--help') || rest.includes('-h')) {
      io.stdout(helpText(command));
      return EXIT.OK;
    }
    switch (command) {
      case 'run':
        return await runCommand(parseArgs(rest, RUN_OPTIONS), rest, io);
      case 'validate':
        return await validateCommand(parseArgs(rest, VALIDATE_OPTIONS), io);
      case 'import':
        return await importCommand(parseArgs(rest, IMPORT_OPTIONS), io);
      case 'export':
        return await exportCommand(parseArgs(rest, EXPORT_OPTIONS), io);
      case 'list':
        return await listCommand(parseArgs(rest, LIST_OPTIONS), io);
      case 'mcp':
        return await mcpCommand(rest, io, streams);
    }
    return EXIT.USAGE;
  } catch (e) {
    const msg = isReqvynError(e) ? e.message : errorMessage(e);
    io.stderr(`${p.red('error:')} ${msg}\n`);
    if (isReqvynError(e) && e.hint) io.stderr(`${p.dim(e.hint)}\n`);
    return isReqvynError(e) && ['VALIDATION', 'NOT_FOUND', 'IMPORT', 'IO'].includes(e.code) ? EXIT.USAGE : EXIT.FAILED;
  }
}
