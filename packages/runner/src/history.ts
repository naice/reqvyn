import { newId, redactSecrets } from '@reqvyn/shared';
import type { HistoryEntry, HttpRequest } from '@reqvyn/core';
import { stripRequestSecrets } from './sanitize.js';
import type { ExecutionOutcome } from './executor.js';

/** Build a history entry. The stored request snapshot never contains secret row values or literal auth secrets. */
export function createHistoryEntry(
  request: HttpRequest,
  outcome: ExecutionOutcome,
  ctx: { collectionId?: string; secrets?: string[] } = {},
): HistoryEntry {
  const sent = outcome.response?.sentRequest;
  return {
    id: newId(),
    timestamp: new Date().toISOString(),
    method: sent?.method ?? request.method,
    url: redactSecrets(sent?.url ?? request.url, ctx.secrets ?? []),
    status: outcome.response?.status,
    durationMs: outcome.response?.timings.totalMs ?? outcome.durationMs,
    size: outcome.response?.body.size,
    collectionId: ctx.collectionId,
    requestId: request.id,
    request: stripRequestSecrets(request),
  };
}
