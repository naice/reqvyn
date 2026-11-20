import { createInterface } from 'node:readline';
import { ReqvynError, errorMessage, isReqvynError, newId } from '@reqvyn/shared';
import {
  buildTree,
  createCollection,
  createRequest,
  parseRequest,
  type Collection,
  type HttpRequest,
  type SecretVault,
  type TreeNode,
} from '@reqvyn/core';
import type { FileSystemStore } from '@reqvyn/collection-engine';
import { importText } from '@reqvyn/import-export';
import { runCollection, stripRequestSecrets, type ExecutorOptions, type RunReport } from '@reqvyn/runner';

/**
 * Trust policy of the MCP server. Everything is off unless the user enables it explicitly on the command line.
 * - read: list/inspect collections (secret values are always stripped)
 * - write: create/modify requests and generate collections in the workspace
 * - network: execute requests (run tests)
 */
export interface McpPolicy {
  allowWrite: boolean;
  allowNetwork: boolean;
  /** Hosts requests may target when network is allowed. Empty = any host. */
  allowedHosts: string[];
}

export interface McpDeps {
  store: FileSystemStore;
  policy: McpPolicy;
  /** Vault used for runs (CI env vars); secret values are never returned to the client. */
  vault?: SecretVault;
  exec?: Omit<ExecutorOptions, 'vault'>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requires?: 'write' | 'network';
  run(args: Record<string, unknown>): Promise<unknown>;
}

const PROTOCOL_VERSION = '2025-06-18';
/** Protocol revisions this server implements (tools only); anything else is answered with the latest. */
const SUPPORTED_PROTOCOL_VERSIONS = new Set([PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const S = { type: 'string' };

function need(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v) throw new ReqvynError('VALIDATION', `Argument "${key}" is required.`);
  return v;
}

function summarizeTree(nodes: TreeNode[]): unknown[] {
  return nodes.map((n) => (n.kind === 'folder' ? { kind: 'folder', id: n.id, name: n.name, children: summarizeTree(n.children) } : { kind: 'request', id: n.id, name: n.name, method: n.method }));
}

/** Results without bodies, headers or secrets – enough for an assistant to reason about failures. */
export function summarizeReport(report: RunReport) {
  return {
    collection: report.collection.name,
    summary: report.summary,
    results: report.results.map((r) => ({
      request: r.requestName,
      requestId: r.requestId,
      iteration: r.iteration,
      status: r.status,
      httpStatus: r.response?.status,
      durationMs: r.response?.timings.totalMs,
      error: r.error ? { code: r.error.code, message: r.error.message } : undefined,
      tests: r.tests.map((t) => ({ name: t.name, passed: t.passed, message: t.message })),
    })),
  };
}

/** Minimal MCP server (JSON-RPC 2.0 over stdio, newline delimited) exposing REQVYN workspace tools. */
export class McpServer {
  private readonly results = new Map<string, ReturnType<typeof summarizeReport>>();
  readonly tools: Tool[];

  constructor(private readonly deps: McpDeps) {
    const store = deps.store;
    const load = (id: string) => store.loadCollection(id);
    const findReq = (c: Collection, id: string): HttpRequest => {
      const r = c.requests.find((x) => x.id === id);
      if (!r) throw new ReqvynError('NOT_FOUND', `Request ${id} not found in collection ${c.name}.`);
      return r;
    };
    this.tools = [
      {
        name: 'list_collections',
        description: 'List the collections and environments in the REQVYN workspace.',
        inputSchema: obj({}),
        run: async () => ({
          collections: await store.listCollections(),
          environments: (await store.listEnvironments()).map((e) => ({ id: e.id, name: e.name })),
        }),
      },
      {
        name: 'get_collection',
        description: 'Show the folder/request tree of a collection.',
        inputSchema: obj({ collectionId: S }, ['collectionId']),
        run: async (a) => {
          const c = await load(need(a, 'collectionId'));
          return { id: c.id, name: c.name, description: c.description, tree: summarizeTree(buildTree(c)) };
        },
      },
      {
        name: 'get_request',
        description: 'Inspect a request definition. Secret values are removed.',
        inputSchema: obj({ collectionId: S, requestId: S }, ['collectionId', 'requestId']),
        run: async (a) => stripRequestSecrets(findReq(await load(need(a, 'collectionId')), need(a, 'requestId'))),
      },
      {
        name: 'create_request',
        description: 'Create a request in a collection. Fields follow the REQVYN request schema (method, url, headers, params, body, auth, tests).',
        inputSchema: obj({ collectionId: S, request: { type: 'object' } }, ['collectionId', 'request']),
        requires: 'write',
        run: async (a) => {
          const c = await load(need(a, 'collectionId'));
          const input = (a.request ?? {}) as Record<string, unknown>;
          const parentId = typeof input.parentId === 'string' ? input.parentId : null;
          if (parentId && !c.folders.some((f) => f.id === parentId)) throw new ReqvynError('NOT_FOUND', `Folder ${parentId} not found.`);
          const sortKey = Math.max(0, ...c.requests.filter((r) => r.parentId === parentId).map((r) => r.sortKey)) + 1;
          const request = parseRequest({ ...createRequest({ parentId, sortKey }), ...input, id: newId(), parentId, sortKey });
          await store.saveRequest(c.id, request);
          return { id: request.id, name: request.name };
        },
      },
      {
        name: 'update_request',
        description: 'Modify fields of an existing request (shallow merge of the given fields).',
        inputSchema: obj({ collectionId: S, requestId: S, changes: { type: 'object' } }, ['collectionId', 'requestId', 'changes']),
        requires: 'write',
        run: async (a) => {
          const c = await load(need(a, 'collectionId'));
          const current = findReq(c, need(a, 'requestId'));
          const changes = (a.changes ?? {}) as Record<string, unknown>;
          const updated = parseRequest({ ...current, ...changes, id: current.id, parentId: current.parentId, updatedAt: new Date().toISOString() });
          await store.saveRequest(c.id, updated);
          return { id: updated.id, name: updated.name };
        },
      },
      {
        name: 'generate_collection',
        description: 'Create a collection from an OpenAPI 3 document, a cURL command or any supported export (Postman, Insomnia, Bruno, Hoppscotch, Thunder Client).',
        inputSchema: obj({ source: S, name: S }, ['source']),
        requires: 'write',
        run: async (a) => {
          const result = importText(need(a, 'source'));
          const collections = result.collections;
          if (!collections.length) throw new ReqvynError('IMPORT', 'The source did not contain a collection.');
          const created = [];
          for (const c of collections) {
            const named = typeof a.name === 'string' && a.name ? createCollection({ ...c, name: a.name }) : c;
            await store.saveCollection(named);
            created.push({ id: named.id, name: named.name, requests: named.requests.length });
          }
          return { format: result.format, created, warnings: result.warnings.map((w) => w.message) };
        },
      },
      {
        name: 'run_tests',
        description: 'Run a collection, folder or selected requests and return test results (no bodies or secrets).',
        inputSchema: obj({ collectionId: S, folderId: S, requestIds: { type: 'array', items: S }, environmentId: S }, ['collectionId']),
        requires: 'network',
        run: async (a) => {
          const c = await load(need(a, 'collectionId'));
          const envId = typeof a.environmentId === 'string' ? a.environmentId : undefined;
          const environment = envId ? (await store.listEnvironments()).find((e) => e.id === envId) : undefined;
          if (envId && !environment) throw new ReqvynError('NOT_FOUND', `Environment ${envId} not found.`);
          const hosts = deps.policy.allowedHosts.map((h) => h.toLowerCase());
          const transport = deps.exec?.transport;
          const allowUrl = (url: string) => {
            const host = new URL(url).hostname.toLowerCase();
            if (hosts.length && !hosts.some((h) => host === h || (h.startsWith('*.') && host.endsWith(h.slice(1))))) {
              throw new ReqvynError('UNTRUSTED', `Host "${host}" is not in the MCP allow-list.`, { hint: 'Start the server with --allow-host <host>.' });
            }
          };
          const exec: ExecutorOptions = {
            ...deps.exec,
            vault: deps.vault,
            // The allow-list is enforced after variable resolution, for every hop: the initial request
            // (transport wrapper), each redirect and OAuth token requests (SendOptions.allowUrl).
            send: { ...deps.exec?.send, allowUrl },
            transport: {
              send: async (req, o) => {
                allowUrl(req.url);
                const t = transport ?? new (await import('@reqvyn/http-engine')).NodeHttpTransport();
                return t.send(req, o);
              },
            },
          };
          const report = await runCollection(
            {
              collection: c,
              folderId: typeof a.folderId === 'string' ? a.folderId : undefined,
              requestIds: Array.isArray(a.requestIds) ? a.requestIds.filter((x): x is string => typeof x === 'string') : undefined,
              environment,
            },
            exec,
          );
          const runId = newId();
          const summary = summarizeReport(report);
          this.results.set(runId, summary);
          if (this.results.size > 20) this.results.delete(this.results.keys().next().value!);
          return { runId, ...summary };
        },
      },
      {
        name: 'get_test_results',
        description: 'Return the results of a previous run_tests call.',
        inputSchema: obj({ runId: S }, ['runId']),
        run: async (a) => {
          const r = this.results.get(need(a, 'runId'));
          if (!r) throw new ReqvynError('NOT_FOUND', 'Unknown runId (results are kept for the last 20 runs of this session).');
          return r;
        },
      },
    ];
  }

  private allowed(t: Tool): string | undefined {
    if (t.requires === 'write' && !this.deps.policy.allowWrite) return 'Writing is disabled. Start the MCP server with --allow-write to permit changes.';
    if (t.requires === 'network' && !this.deps.policy.allowNetwork) return 'Network access is disabled. Start the MCP server with --allow-network to permit running requests.';
    return undefined;
  }

  /** Handle one JSON-RPC message; returns the response (undefined for notifications). */
  async handle(msg: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
    const reply = (result: unknown) => (msg.id === undefined ? undefined : { jsonrpc: '2.0', id: msg.id, result });
    const fail = (code: number, message: string) => (msg.id === undefined ? undefined : { jsonrpc: '2.0', id: msg.id, error: { code, message } });
    switch (msg.method) {
      case 'initialize': {
        const requested = typeof msg.params?.protocolVersion === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(msg.params.protocolVersion) ? msg.params.protocolVersion : PROTOCOL_VERSION;
        return reply({
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'reqvyn', version: '0.1.0' },
          instructions: 'REQVYN workspace tools. Secret values are never returned. Write and network access depend on the user-controlled policy.',
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({
          tools: this.tools.map((t) => ({
            name: t.name,
            description: `${t.description}${this.allowed(t) ? ' (currently disabled by policy)' : ''}`,
            inputSchema: t.inputSchema,
          })),
        });
      case 'tools/call': {
        const name = msg.params?.name;
        const tool = this.tools.find((t) => t.name === name);
        if (!tool) return fail(-32602, `Unknown tool: ${String(name)}`);
        const denied = this.allowed(tool);
        if (denied) return reply({ content: [{ type: 'text', text: denied }], isError: true });
        try {
          const result = await tool.run((msg.params?.arguments ?? {}) as Record<string, unknown>);
          return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
        } catch (e) {
          const text = isReqvynError(e) ? `${e.code}: ${e.message}${e.hint ? ` (${e.hint})` : ''}` : errorMessage(e);
          return reply({ content: [{ type: 'text', text }], isError: true });
        }
      }
      default:
        if (msg.method.startsWith('notifications/')) return undefined;
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  }

  /** Serve over stdio until stdin closes. Logs go to stderr only (stdout carries the protocol). */
  serve(input: NodeJS.ReadableStream, output: (line: string) => void): Promise<void> {
    const rl = createInterface({ input });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(line) as JsonRpcRequest;
      } catch {
        output(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      void this.handle(msg).then((res) => {
        if (res) output(JSON.stringify(res));
      });
    });
    return new Promise((done) => rl.on('close', () => done()));
  }
}
