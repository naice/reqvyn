export type ReqvynErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IO'
  | 'DNS'
  | 'TLS'
  | 'PROXY'
  | 'CONNECTION'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INVALID_RESPONSE'
  | 'TOO_LARGE'
  | 'AUTH'
  | 'SCRIPT'
  | 'IMPORT'
  | 'SYNC'
  | 'UNTRUSTED'
  | 'CYCLE'
  | 'INTERNAL';

export interface ReqvynErrorJson {
  code: ReqvynErrorCode;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export class ReqvynError extends Error {
  readonly code: ReqvynErrorCode;
  readonly details?: Record<string, unknown>;
  readonly hint?: string;

  constructor(
    code: ReqvynErrorCode,
    message: string,
    opts: { cause?: unknown; details?: Record<string, unknown>; hint?: string } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ReqvynError';
    this.code = code;
    this.details = opts.details;
    this.hint = opts.hint;
  }

  toJSON(): ReqvynErrorJson {
    return { code: this.code, message: this.message, hint: this.hint, details: this.details };
  }
}

export function isReqvynError(e: unknown): e is ReqvynError {
  return e instanceof ReqvynError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ReqvynError');
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function toErrorJson(e: unknown): ReqvynErrorJson {
  if (isReqvynError(e)) return e.toJSON();
  return { code: 'INTERNAL', message: errorMessage(e) };
}
