import { ReqvynError } from './errors.js';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ReqvynError('CANCELLED', 'Operation cancelled'));
    const onAbort = () => {
      clearTimeout(t);
      reject(new ReqvynError('CANCELLED', 'Operation cancelled'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ReqvynError('CANCELLED', 'Operation cancelled');
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/** Retry with exponential backoff and jitter. */
export async function retryWithBackoff<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  let attempt = 0;
  for (;;) {
    throwIfAborted(opts.signal);
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= opts.retries || (opts.shouldRetry && !opts.shouldRetry(e, attempt))) throw e;
      const exp = Math.min(opts.maxDelayMs ?? 30_000, opts.baseDelayMs * 2 ** attempt);
      const delay = Math.round(exp / 2 + Math.random() * (exp / 2));
      opts.onRetry?.(e, attempt + 1, delay);
      await sleep(delay, opts.signal);
      attempt++;
    }
  }
}

/** Map with at most `limit` concurrent operations, preserving result order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Debouncer keyed by string, used for coalescing persistent writes. */
export class KeyedDebouncer {
  private timers = new Map<string, { t: ReturnType<typeof setTimeout>; fn: () => void }>();
  constructor(private readonly delayMs: number) {}

  schedule(key: string, fn: () => void): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing.t);
    const t = setTimeout(() => {
      this.timers.delete(key);
      fn();
    }, this.delayMs);
    this.timers.set(key, { t, fn });
  }

  flushAll(): void {
    for (const { t, fn } of this.timers.values()) {
      clearTimeout(t);
      fn();
    }
    this.timers.clear();
  }

  dispose(): void {
    for (const { t } of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
