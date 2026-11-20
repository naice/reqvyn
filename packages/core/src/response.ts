import type { ReqvynErrorJson } from '@reqvyn/shared';

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  maxAge?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
}

export interface Timings {
  /** Epoch ms when the request started. */
  startedAt: number;
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  /** Time to first byte measured from request start. */
  firstByteMs?: number;
  downloadMs?: number;
  totalMs: number;
}

export interface TimelineEvent {
  at: number;
  type: 'info' | 'request' | 'response' | 'redirect' | 'tls' | 'dns' | 'connect' | 'error' | 'script' | 'auth';
  message: string;
}

export interface ResponseBody {
  /** Base64 of the (possibly truncated) body bytes kept in memory. */
  base64: string;
  /** Total number of body bytes received (after decompression). */
  size: number;
  /** True if the body exceeded the in-memory limit; only the first bytes are kept in `base64`. */
  truncated: boolean;
  /** When streaming to disk was requested or the limit was exceeded with a download target, the path the body was saved to. */
  savedTo?: string;
}

export interface HttpResponseData {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: Array<[string, string]>;
  contentType: string;
  body: ResponseBody;
  timings: Timings;
  redirects: Array<{ url: string; status: number }>;
  cookies: Cookie[];
  headersSize: number;
  finalUrl: string;
  remoteAddress?: string;
  timeline: TimelineEvent[];
  /** The request as it was actually sent (after variable resolution and auth). Sensitive headers are redacted. */
  sentRequest: { method: string; url: string; headers: Array<[string, string]>; bodyPreview?: string };
}

export interface TestResult {
  id: string;
  name: string;
  passed: boolean;
  message?: string;
  source: 'assertion' | 'script';
  /** Nested results for assertion groups. */
  children?: TestResult[];
}

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  at: number;
}

export interface ExecutionResult {
  requestId?: string;
  requestName: string;
  response?: HttpResponseData;
  error?: ReqvynErrorJson;
  tests: TestResult[];
  console: ConsoleEntry[];
  /** Variables set during execution (chaining/scripts), by scope. Secret values are masked. */
  variableChanges: Array<{ scope: string; key: string; value: string }>;
  skipped?: boolean;
}

export interface HistoryEntry {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  size?: number;
  collectionId?: string;
  requestId?: string;
  /** Request snapshot (unresolved; sensitive literal values stripped). */
  request: unknown;
}

export function headerValue(headers: Array<[string, string]>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of headers) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export function decodeBase64Text(b64: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
