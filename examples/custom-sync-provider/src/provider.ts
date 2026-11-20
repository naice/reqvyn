/**
 * Example third-party sync provider: a self-hosted REST service. Depends only on
 * `@reqvyn/provider-sdk` and the global `fetch` (Node 18+ / VS Code extension host) – no `vscode`
 * import, so it can be unit-tested and reused outside the editor.
 *
 * Wire protocol (implemented by `server.ts`):
 *
 * | Method | Path                              | Notes                                              |
 * |--------|-----------------------------------|----------------------------------------------------|
 * | GET    | /health                           | `{ ok: true }`                                     |
 * | GET    | /collections                      | `RemoteCollectionInfo[]`                           |
 * | GET    | /collections/:id/manifest         | `SyncManifest`, `ETag: "<revision>"`, 404 if absent |
 * | GET    | /collections/:id/snapshot         | `SyncSnapshot`, `ETag`, 404 if absent              |
 * | PUT    | /collections/:id/snapshot         | `If-Match: "<rev>"` or `If-None-Match: *`; 412/409 on mismatch |
 * | DELETE | /collections/:id                  | `If-Match` optional                                |
 *
 * All requests carry `Authorization: Bearer <token>`; the token comes from the instance's scoped
 * secret storage and never appears in logs or error messages.
 */
import {
  SyncProviderError,
  configBoolean,
  configNumber,
  configString,
  throwIfCancelled,
  toSyncProviderError,
  validateSnapshot,
  withRetry,
  type RemoteCollectionInfo,
  type SyncHealthResult,
  type SyncManifest,
  type SyncOperationOptions,
  type SyncProvider,
  type SyncProviderCapabilities,
  type SyncProviderContext,
  type SyncProviderDescriptor,
  type SyncProviderErrorCode,
  type SyncProviderFactory,
  type SyncPushResult,
  type SyncSnapshot,
} from '@reqvyn/provider-sdk';

export const REST_PROVIDER_ID = 'reqvyn-examples.rest';

const capabilities: SyncProviderCapabilities = Object.freeze({
  read: true,
  write: true,
  optimisticConcurrency: true,
  list: true,
  delete: true,
  auth: false,
});

export const restDescriptor: SyncProviderDescriptor = {
  id: REST_PROVIDER_ID,
  displayName: 'Self-hosted REST server',
  description: 'Synchronize collections with your own REST sync server (see the example server.ts).',
  version: '0.1.0',
  capabilities,
  configSchema: [
    { key: 'baseUrl', label: 'Server URL', type: 'url', required: true, placeholder: 'https://sync.example.com/api/' },
    { key: 'token', label: 'Access token', type: 'secret', required: true },
    { key: 'timeoutMs', label: 'Request timeout (ms)', type: 'number', default: 15_000 },
    { key: 'retries', label: 'Retries', type: 'number', default: 3 },
    { key: 'allowInsecureHttp', label: 'Allow plain HTTP to non-local hosts', type: 'boolean', default: false },
  ],
};

export interface RestProviderOptions {
  /** Override `fetch` (tests, proxies). */
  fetch?: typeof fetch;
  /** Backoff base delay (default 250 ms). */
  retryBaseDelayMs?: number;
}

/** Map an HTTP status to a provider error code. */
export function statusToCode(status: number): SyncProviderErrorCode {
  if (status === 401) return 'AUTH';
  if (status === 403) return 'PERMISSION';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409 || status === 412) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'INVALID_DATA';
  if (status === 408 || status >= 500) return 'UNAVAILABLE';
  return 'INTERNAL';
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

const quote = (rev: string) => `"${rev.replace(/["\\]/g, '')}"`;
const unquote = (etag: string | null) => (etag ? etag.replace(/^W\//, '').replace(/^"|"$/g, '') : null);

export class RestSyncProvider implements SyncProvider {
  readonly id = REST_PROVIDER_ID;
  readonly displayName = 'Self-hosted REST server';
  readonly capabilities = capabilities;
  private ctx: SyncProviderContext | undefined;
  private base: URL | undefined;
  private timeoutMs = 15_000;
  private retries = 3;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RestProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
  }

  async initialize(context: SyncProviderContext): Promise<void> {
    const raw = configString(context.config, 'baseUrl');
    if (!raw) throw new SyncProviderError('CONFIG', 'Server URL is required');
    let url: URL;
    try {
      url = new URL(raw.endsWith('/') ? raw : `${raw}/`);
    } catch {
      throw new SyncProviderError('CONFIG', 'Server URL is not a valid URL');
    }
    if (url.username || url.password) throw new SyncProviderError('CONFIG', 'Do not put credentials into the server URL; use the access token field');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'http:' && !local && !configBoolean(context.config, 'allowInsecureHttp')) {
      throw new SyncProviderError('CONFIG', 'Refusing to send the access token over plain HTTP; use HTTPS');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SyncProviderError('CONFIG', 'Server URL must be http(s)');
    this.base = url;
    this.timeoutMs = configNumber(context.config, 'timeoutMs') ?? 15_000;
    this.retries = configNumber(context.config, 'retries') ?? 3;
    this.ctx = context;
  }

  private url(...segments: string[]): URL {
    if (!this.base) throw new SyncProviderError('UNAVAILABLE', 'Provider is not initialized');
    return new URL(segments.map(encodeURIComponent).join('/'), this.base);
  }

  /** One HTTP request with auth, timeout, cancellation and error mapping (no retries). */
  private async request(method: string, url: URL, init: { headers?: Record<string, string>; body?: unknown; signal?: AbortSignal; okStatuses?: number[] } = {}): Promise<Response> {
    const ctx = this.ctx;
    if (!ctx) throw new SyncProviderError('UNAVAILABLE', 'Provider is not initialized');
    throwIfCancelled(init.signal);
    const token = await ctx.secrets.get('token');
    if (!token) throw new SyncProviderError('AUTH', 'No access token configured');
    const signals = [AbortSignal.timeout(this.timeoutMs), ctx.signal, init.signal].filter((s): s is AbortSignal => !!s);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.any(signals),
        redirect: 'error', // never forward the bearer token to another origin
      });
    } catch (e) {
      if (init.signal?.aborted || ctx.signal.aborted) throw new SyncProviderError('CANCELLED', 'Request cancelled');
      if ((e as Error)?.name === 'TimeoutError') throw new SyncProviderError('NETWORK', `Request timed out after ${this.timeoutMs} ms`);
      throw toSyncProviderError(e, `Could not reach the sync server (${url.host})`);
    }
    if (res.ok || init.okStatuses?.includes(res.status)) return res;
    let detail = '';
    try {
      const text = (await res.text()).slice(0, 500);
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body.error === 'string') detail = body.error.split(token).join('***').slice(0, 200);
    } catch {
      /* no JSON body */
    }
    throw new SyncProviderError(statusToCode(res.status), `Sync server responded ${res.status}${detail ? `: ${detail}` : ''}`, {
      status: res.status,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    });
  }

  private retry<T>(fn: () => Promise<T>, options?: SyncOperationOptions): Promise<T> {
    return withRetry(fn, {
      retries: this.retries,
      baseDelayMs: this.options.retryBaseDelayMs ?? 250,
      signal: options?.signal,
      onRetry: (err, attempt, delayMs) => {
        this.ctx?.logger.debug(`rest: retry ${attempt} after ${err.code}`, { delayMs });
        options?.progress?.report({ phase: 'retry', message: `Retrying (${err.code})` });
      },
    });
  }

  async getRemoteManifest(collectionId: string, options?: SyncOperationOptions): Promise<SyncManifest | null> {
    return this.retry(async () => {
      const res = await this.request('GET', this.url('collections', collectionId, 'manifest'), { signal: options?.signal, okStatuses: [404] });
      if (res.status === 404) return null;
      const m = (await res.json()) as SyncManifest;
      if (!m || typeof m.revision !== 'string' || m.collectionId !== collectionId) throw new SyncProviderError('INVALID_DATA', 'Server returned an invalid manifest');
      return m;
    }, options);
  }

  async pull(collectionId: string, options?: SyncOperationOptions): Promise<SyncSnapshot | null> {
    options?.progress?.report({ phase: 'pull', message: 'Downloading', collectionId });
    return this.retry(async () => {
      const res = await this.request('GET', this.url('collections', collectionId, 'snapshot'), { signal: options?.signal, okStatuses: [404] });
      if (res.status === 404) return null;
      const snap = validateSnapshot(await res.json(), { collectionId });
      return { ...snap, revision: unquote(res.headers.get('etag')) ?? snap.revision };
    }, options);
  }

  async push(collectionId: string, snapshot: SyncSnapshot, expectedRevision?: string | null, options?: SyncOperationOptions): Promise<SyncPushResult> {
    options?.progress?.report({ phase: 'push', message: 'Uploading', collectionId });
    const headers: Record<string, string> = {};
    if (expectedRevision === null) headers['if-none-match'] = '*';
    else if (typeof expectedRevision === 'string') headers['if-match'] = quote(expectedRevision);
    // Conditional PUTs are safe to retry: a retried PUT whose first attempt landed yields 412,
    // which the engine resolves by re-pulling (the content is then identical).
    return this.retry(async () => {
      const res = await this.request('PUT', this.url('collections', collectionId, 'snapshot'), {
        headers,
        body: { ...snapshot, revision: null },
        signal: options?.signal,
        okStatuses: [409, 412],
      });
      if (res.status === 409 || res.status === 412) {
        const body = (await res.json().catch(() => ({}))) as { currentRevision?: string | null };
        return { status: 'conflict', remoteRevision: body.currentRevision ?? unquote(res.headers.get('etag')), message: 'Remote changed' } as const;
      }
      const body = (await res.json()) as { revision?: string; updatedAt?: string };
      const revision = body.revision ?? unquote(res.headers.get('etag'));
      if (!revision) throw new SyncProviderError('INVALID_DATA', 'Server did not return a revision');
      return { status: 'ok', revision, updatedAt: body.updatedAt } as const;
    }, options);
  }

  async testConnection(options?: SyncOperationOptions): Promise<SyncHealthResult> {
    const started = Date.now();
    try {
      await this.request('GET', this.url('health'), { signal: options?.signal });
      // /health may be public; verify the token on an authenticated endpoint too.
      await this.request('GET', this.url('collections'), { signal: options?.signal });
      return { ok: true, message: `Connected to ${this.base?.host}`, latencyMs: Date.now() - started };
    } catch (e) {
      const err = toSyncProviderError(e);
      return { ok: false, message: err.message, code: err.code, latencyMs: Date.now() - started };
    }
  }

  async listRemoteCollections(options?: SyncOperationOptions): Promise<RemoteCollectionInfo[]> {
    return this.retry(async () => {
      const res = await this.request('GET', this.url('collections'), { signal: options?.signal });
      const list = (await res.json()) as RemoteCollectionInfo[];
      if (!Array.isArray(list)) throw new SyncProviderError('INVALID_DATA', 'Server returned an invalid collection list');
      return list;
    }, options);
  }

  async deleteRemoteCollection(collectionId: string, expectedRevision?: string | null, options?: SyncOperationOptions): Promise<void> {
    const headers: Record<string, string> = typeof expectedRevision === 'string' ? { 'if-match': quote(expectedRevision) } : {};
    await this.retry(() => this.request('DELETE', this.url('collections', collectionId), { headers, signal: options?.signal, okStatuses: [404] }), options);
  }

  async dispose(): Promise<void> {
    this.ctx = undefined;
  }
}

export function createRestProviderFactory(options: RestProviderOptions = {}): SyncProviderFactory {
  return { descriptor: restDescriptor, create: () => new RestSyncProvider(options) };
}

export const restProviderFactory = createRestProviderFactory();
