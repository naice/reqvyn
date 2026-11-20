/**
 * Reference implementation of the REST sync protocol used by `provider.ts`, built on `node:http`
 * only. Stores snapshots in memory (swap `store` for a database in a real deployment). Intended
 * for local testing and as a template – put it behind HTTPS (reverse proxy) before exposing it.
 *
 * Run: `node --experimental-strip-types src/server.ts` with `REQVYN_SYNC_TOKEN` set.
 */
import { timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { computeSnapshotRevision, manifestFromSnapshot, validateSnapshot, type SyncSnapshot } from '@reqvyn/provider-sdk';

export interface ReferenceServerOptions {
  /** Bearer token clients must present. */
  token: string;
  /** Maximum request body (default 32 MiB). */
  maxBodyBytes?: number;
}

/** Fault injection for tests. */
export class FaultInjector {
  private queue: Array<{ status: number; retryAfter?: string; path?: RegExp }> = [];
  dropNext = 0;
  delayMs = 0;
  /** The next `count` requests (optionally matching `path`) fail with `status`. */
  failNext(count: number, status: number, opts: { retryAfter?: string; path?: RegExp } = {}): this {
    for (let i = 0; i < count; i++) this.queue.push({ status, ...opts });
    return this;
  }
  take(path: string) {
    const i = this.queue.findIndex((f) => !f.path || f.path.test(path));
    return i >= 0 ? this.queue.splice(i, 1)[0] : undefined;
  }
}

export interface ReferenceServer {
  readonly server: http.Server;
  readonly store: Map<string, SyncSnapshot & { revision: string; updatedAt: string }>;
  readonly faults: FaultInjector;
  /** Number of handled requests by "METHOD path-pattern". */
  readonly requests: string[];
  listen(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/i.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: http.IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

const etag = (rev: string) => `"${rev}"`;
const unquote = (v: string) => v.trim().replace(/^W\//, '').replace(/^"|"$/g, '');

export function createReferenceServer(options: ReferenceServerOptions): ReferenceServer {
  if (!options.token) throw new Error('A token is required');
  const store: ReferenceServer['store'] = new Map();
  const faults = new FaultInjector();
  const requests: string[] = [];
  const max = options.maxBodyBytes ?? 32 * 1024 * 1024;

  const send = (res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  const checkPrecondition = (req: http.IncomingMessage, current: string | null) => {
    const ifMatch = req.headers['if-match'];
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch === '*' && current !== null) throw new HttpError(412, 'Collection already exists', { currentRevision: current });
    if (typeof ifMatch === 'string') {
      const wanted = ifMatch.split(',').map(unquote);
      if (current === null || (!wanted.includes('*') && !wanted.includes(current))) {
        throw new HttpError(412, 'Revision mismatch', { currentRevision: current });
      }
    }
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    requests.push(`${req.method} /${parts[0] ?? ''}${parts.length > 2 ? `/:id/${parts[2]}` : parts.length > 1 ? '/:id' : ''}`);
    if (faults.dropNext > 0) {
      faults.dropNext--;
      req.socket.destroy();
      return;
    }
    if (faults.delayMs) await new Promise((r) => setTimeout(r, faults.delayMs));
    const fault = faults.take(url.pathname);
    if (fault) return send(res, fault.status, { error: 'Injected failure' }, fault.retryAfter ? { 'retry-after': fault.retryAfter } : {});

    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'health') return send(res, 200, { ok: true });
    if (!tokenMatches(req.headers.authorization, options.token)) {
      return send(res, 401, { error: 'Invalid or missing bearer token' }, { 'www-authenticate': 'Bearer' });
    }
    if (parts[0] !== 'collections') throw new HttpError(404, 'Not found');

    if (parts.length === 1 && req.method === 'GET') {
      return send(
        res,
        200,
        [...store.values()].map((s) => ({ collectionId: s.collectionId, label: s.label, revision: s.revision, updatedAt: s.updatedAt })),
      );
    }
    const id = parts[1];
    if (!id) throw new HttpError(404, 'Not found');
    const current = store.get(id) ?? null;

    if (parts.length === 2 && req.method === 'DELETE') {
      checkPrecondition(req, current?.revision ?? null);
      if (!current) throw new HttpError(404, 'Collection not found');
      store.delete(id);
      return send(res, 204);
    }
    if (parts.length !== 3) throw new HttpError(404, 'Not found');

    if (parts[2] === 'manifest' && req.method === 'GET') {
      if (!current) throw new HttpError(404, 'Collection not found');
      return send(res, 200, manifestFromSnapshot(current, current.revision, current.updatedAt), { etag: etag(current.revision) });
    }
    if (parts[2] === 'snapshot' && req.method === 'GET') {
      if (!current) throw new HttpError(404, 'Collection not found');
      return send(res, 200, current, { etag: etag(current.revision) });
    }
    if (parts[2] === 'snapshot' && req.method === 'PUT') {
      const body = await readBody(req, max);
      let snap: SyncSnapshot;
      try {
        snap = validateSnapshot(body, { collectionId: id });
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
      // Precondition check and write are synchronous → atomic within this process.
      checkPrecondition(req, current?.revision ?? null);
      const revision = computeSnapshotRevision(snap);
      const updatedAt = new Date().toISOString();
      store.set(id, { ...snap, revision, updatedAt });
      return send(res, current ? 200 : 201, { revision, updatedAt }, { etag: etag(revision) });
    }
    throw new HttpError(405, 'Method not allowed');
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
      send(res, 500, { error: 'Internal server error' });
    });
  });

  return {
    server,
    store,
    faults,
    requests,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const a = server.address() as AddressInfo;
          resolve(`http://${host}:${a.port}/`);
        });
      });
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// Allow `node --experimental-strip-types src/server.ts` for manual testing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.REQVYN_SYNC_TOKEN;
  if (!token) {
    console.error('Set REQVYN_SYNC_TOKEN');
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8787);
  void createReferenceServer({ token })
    .listen(port, process.env.HOST ?? '127.0.0.1')
    .then((u) => console.log(`REQVYN reference sync server listening on ${u}`));
}
