import { SyncProviderError, isRetryable, toSyncProviderError } from './errors.js';

/** Throw a `CANCELLED` {@link SyncProviderError} if `signal` is aborted. */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SyncProviderError('CANCELLED', 'Operation cancelled');
}

/** Abortable delay. Rejects with a `CANCELLED` error when aborted. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new SyncProviderError('CANCELLED', 'Operation cancelled'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SyncProviderError('CANCELLED', 'Operation cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface ProviderRetryOptions {
  /** Additional attempts after the first one (default 3). */
  retries?: number;
  /** Base delay for exponential backoff (default 250 ms). */
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (error: SyncProviderError, attempt: number, delayMs: number) => void;
}

/**
 * Retry `fn` with exponential backoff + jitter while it fails with a retryable error
 * ({@link isRetryable}). Honours `retryAfterMs` of `RATE_LIMIT` errors. Errors are normalized
 * to {@link SyncProviderError}.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: ProviderRetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 3;
  const base = options.baseDelayMs ?? 250;
  const max = options.maxDelayMs ?? 10_000;
  for (let attempt = 0; ; attempt++) {
    throwIfCancelled(options.signal);
    try {
      return await fn(attempt);
    } catch (e) {
      const err = toSyncProviderError(e);
      if (err.code === 'CANCELLED' || attempt >= retries || !isRetryable(err)) throw err;
      const exp = Math.min(max, base * 2 ** attempt);
      const wait = Math.max(err.retryAfterMs ?? 0, Math.round(exp / 2 + Math.random() * (exp / 2)));
      options.onRetry?.(err, attempt + 1, wait);
      await delay(Math.min(wait, max), options.signal);
    }
  }
}
