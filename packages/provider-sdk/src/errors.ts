/**
 * Structured provider errors. Providers should throw {@link SyncProviderError} for every expected
 * failure so that REQVYN can show helpful messages and decide whether to retry.
 */

/** Machine-readable error codes understood by the REQVYN sync engine. */
export type SyncProviderErrorCode =
  /** Missing, invalid or expired credentials. The user must re-authenticate. */
  | 'AUTH'
  /** The remote collection / resource does not exist. */
  | 'NOT_FOUND'
  /** Optimistic-concurrency violation or another writer won. Prefer returning a `conflict` push result. */
  | 'CONFLICT'
  /** Transport failure (DNS, connection reset, timeout, offline). Retryable. */
  | 'NETWORK'
  /** The remote throttled the request. Retryable; set `retryAfterMs` when known. */
  | 'RATE_LIMIT'
  /** Authenticated but not allowed (read-only share, missing scope, file permissions). */
  | 'PERMISSION'
  /** Remote data is malformed, corrupted or of an unsupported format version. */
  | 'INVALID_DATA'
  /** Remote temporarily unavailable (5xx, locked, maintenance). Retryable. */
  | 'UNAVAILABLE'
  /** The operation was cancelled through its `AbortSignal`. */
  | 'CANCELLED'
  /** Invalid provider configuration supplied by the user. */
  | 'CONFIG'
  /** Unexpected failure / provider bug. */
  | 'INTERNAL';

const DEFAULT_RETRYABLE: Record<SyncProviderErrorCode, boolean> = {
  AUTH: false,
  NOT_FOUND: false,
  CONFLICT: false,
  NETWORK: true,
  RATE_LIMIT: true,
  PERMISSION: false,
  INVALID_DATA: false,
  UNAVAILABLE: true,
  CANCELLED: false,
  CONFIG: false,
  INTERNAL: false,
};

/** Serializable error shape (safe to persist in sync state and to show in UI). */
export interface SyncProviderErrorJson {
  name: 'SyncProviderError';
  code: SyncProviderErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  /** Provider-specific status (e.g. HTTP status code or git exit code). */
  status?: number;
  details?: Record<string, unknown>;
}

export interface SyncProviderErrorOptions {
  /** Override the default retryability of the code. */
  retryable?: boolean;
  retryAfterMs?: number;
  status?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Error thrown by sync providers. Never put credentials into `message` or `details` – these are
 * logged and persisted.
 */
export class SyncProviderError extends Error {
  readonly code: SyncProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(code: SyncProviderErrorCode, message: string, options: SyncProviderErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SyncProviderError';
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
    this.details = options.details;
  }

  toJSON(): SyncProviderErrorJson {
    return {
      name: 'SyncProviderError',
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      status: this.status,
      details: this.details,
    };
  }
}

const CODES = new Set(Object.keys(DEFAULT_RETRYABLE));

/**
 * Duck-typed check (works across package copies / realms, unlike `instanceof`).
 */
export function isSyncProviderError(e: unknown): e is SyncProviderError {
  if (e instanceof SyncProviderError) return true;
  if (typeof e !== 'object' || e === null) return false;
  const x = e as { name?: unknown; code?: unknown; retryable?: unknown };
  return x.name === 'SyncProviderError' && typeof x.code === 'string' && CODES.has(x.code) && typeof x.retryable === 'boolean';
}

/** True if retrying the failed operation may succeed (network failures, throttling, 5xx …). */
export function isRetryable(e: unknown): boolean {
  if (isSyncProviderError(e)) return e.retryable;
  return toSyncProviderError(e).retryable;
}

const NETWORK_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/** Errno codes that indicate a transient file-system condition (network shares, USB sticks). */
const TRANSIENT_FS_ERRNO = new Set(['EBUSY', 'EAGAIN', 'EIO', 'ESTALE', 'EMFILE', 'ENFILE']);

/**
 * Normalize any thrown value into a {@link SyncProviderError}. Recognizes abort errors, Node.js
 * errno codes (network + file system) and `fetch` network failures.
 */
export function toSyncProviderError(e: unknown, fallbackMessage = 'Sync provider failed'): SyncProviderError {
  if (e instanceof SyncProviderError) return e;
  if (isSyncProviderError(e)) {
    return new SyncProviderError(e.code, e.message, {
      retryable: e.retryable,
      retryAfterMs: e.retryAfterMs,
      status: e.status,
      details: e.details,
      cause: e,
    });
  }
  const err = e as { name?: string; code?: string; message?: string; cause?: { code?: string } } | undefined;
  const message = typeof err?.message === 'string' && err.message ? err.message : fallbackMessage;
  const name = err?.name;
  const code = err?.code ?? err?.cause?.code;
  if (name === 'AbortError' || code === 'ABORT_ERR' || code === 'CANCELLED') {
    return new SyncProviderError('CANCELLED', 'Operation cancelled', { cause: e });
  }
  if (name === 'TimeoutError') return new SyncProviderError('NETWORK', message, { cause: e });
  if (typeof code === 'string') {
    if (NETWORK_ERRNO.has(code)) return new SyncProviderError('NETWORK', message, { cause: e, details: { errno: code } });
    if (code === 'ENOENT' || code === 'ENOTDIR') return new SyncProviderError('NOT_FOUND', message, { cause: e, details: { errno: code } });
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return new SyncProviderError('PERMISSION', message, { cause: e, details: { errno: code } });
    }
    if (TRANSIENT_FS_ERRNO.has(code)) return new SyncProviderError('UNAVAILABLE', message, { cause: e, details: { errno: code } });
  }
  // `fetch` reports network failures as `TypeError: fetch failed`.
  if (name === 'TypeError' && /fetch failed|network/i.test(message)) {
    return new SyncProviderError('NETWORK', message, { cause: e });
  }
  return new SyncProviderError('INTERNAL', message, { cause: e });
}
