import { z } from 'zod';
import type { ReqvynErrorJson } from '@reqvyn/shared';
import {
  AssertionGroupSchema,
  AuthSchema,
  CollectionInfoSchema,
  EnvironmentSchema,
  FolderSchema,
  HttpRequestSchema,
  KeyValueSchema,
  RunnerSettingsSchema,
  type CollectionInfo,
  type Environment,
  type Folder,
  type HttpRequest,
} from './models.js';
import type { ExecutionResult } from './response.js';

/**
 * Message protocol between Webviews (presentation only) and the extension host (privileged).
 * Every message coming FROM a webview is validated with `WebviewToHostSchema` before it is handled.
 * Messages TO the webview are typed by `HostToWebview`.
 */

export const WEBVIEW_VIEWS = ['request', 'environment', 'runner', 'container'] as const;
export type WebviewView = (typeof WEBVIEW_VIEWS)[number];

export const CODEGEN_TARGETS = ['curl', 'fetch', 'typescript', 'node', 'python', 'csharp', 'powershell'] as const;
export type CodegenTarget = (typeof CODEGEN_TARGETS)[number];

/** A variable visible to the UI. Secret values are always masked before being sent to a webview. */
export interface UiVariable {
  key: string;
  value: string;
  source: string;
  secret: boolean;
}

export interface RequestContext {
  storeId?: string;
  collectionId?: string;
  collectionName?: string;
  /** Folder names from root to the request's parent. */
  path: string[];
  inheritedHeaders: Array<{ key: string; value: string; source: string }>;
  inheritedAuth: { type: string; source: string };
  /** True when the request is not stored in a collection (scratch request). */
  scratch: boolean;
}

export interface RunnerConfigUi {
  storeId: string;
  collectionId: string;
  folderId?: string | null;
  collectionName: string;
  requests: Array<{ id: string; name: string; method: string; path: string }>;
}

export interface RunnerProgress {
  iteration: number;
  totalIterations: number;
  completed: number;
  total: number;
  current?: { requestId: string; name: string };
  result?: ExecutionResult & { iteration: number; durationMs?: number };
}

export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  assertions: { passed: number; failed: number };
  cancelled: boolean;
}

export type HostToWebview =
  | { type: 'init'; view: WebviewView; brand: { iconUri: string } }
  | {
      type: 'request:state';
      request: HttpRequest;
      context: RequestContext;
      dirty: boolean;
      environments: Array<{ id: string; name: string; color?: string }>;
      activeEnvironmentId: string | null;
      variables: UiVariable[];
      trusted: boolean;
    }
  | { type: 'request:variables'; variables: UiVariable[]; activeEnvironmentId: string | null }
  | { type: 'request:saved'; request: HttpRequest }
  | { type: 'response:started'; startedAt: number }
  | { type: 'response:result'; result: ExecutionResult }
  | { type: 'response:cancelled' }
  | { type: 'codegen:result'; target: CodegenTarget; code: string }
  | { type: 'file:picked'; token: string; path: string | null }
  | { type: 'oauth2:status'; status: 'idle' | 'running' | 'success' | 'error'; message?: string; expiresAt?: string; userCode?: string; verificationUri?: string }
  | { type: 'environment:state'; environment: Environment; isGlobal: boolean; dirty: boolean }
  | { type: 'container:state'; level: 'collection'; collection: CollectionInfo; dirty: boolean }
  | { type: 'container:state'; level: 'folder'; folder: Folder; collectionName: string; dirty: boolean }
  | { type: 'runner:config'; config: RunnerConfigUi; environments: Array<{ id: string; name: string }>; activeEnvironmentId: string | null; defaults: z.infer<typeof RunnerSettingsSchema> }
  | { type: 'runner:progress'; progress: RunnerProgress }
  | { type: 'runner:done'; summary: RunSummary }
  | { type: 'runner:error'; error: ReqvynErrorJson }
  | { type: 'toast'; level: 'info' | 'warning' | 'error'; message: string };

const RunnerStartSchema = z.object({
  type: z.literal('runner:start'),
  options: RunnerSettingsSchema.extend({
    environmentId: z.string().nullable(),
    skip: z.array(z.string()).default([]),
    dataFile: z.string().optional(),
    persistVariables: z.boolean().default(false),
  }),
});

export const WebviewToHostSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  // --- request editor
  z.object({ type: z.literal('request:update'), request: HttpRequestSchema }),
  z.object({ type: z.literal('request:send'), request: HttpRequestSchema }),
  z.object({ type: z.literal('request:cancel') }),
  z.object({ type: z.literal('request:save'), request: HttpRequestSchema }),
  z.object({ type: z.literal('request:saveAs'), request: HttpRequestSchema }),
  z.object({ type: z.literal('request:copyAsCurl'), request: HttpRequestSchema }),
  z.object({ type: z.literal('codegen'), target: z.enum(CODEGEN_TARGETS), request: HttpRequestSchema }),
  z.object({ type: z.literal('environment:select'), environmentId: z.string().nullable() }),
  z.object({ type: z.literal('response:saveBody') }),
  z.object({ type: z.literal('response:openInEditor') }),
  z.object({ type: z.literal('response:compare') }),
  z.object({ type: z.literal('clipboard:write'), text: z.string().max(50_000_000) }),
  z.object({ type: z.literal('file:pick'), token: z.string(), purpose: z.enum(['binary', 'multipart', 'cert', 'key', 'pfx', 'data']) }),
  z.object({ type: z.literal('oauth2:getToken'), auth: AuthSchema }),
  z.object({ type: z.literal('oauth2:clearToken'), auth: AuthSchema }),
  z.object({ type: z.literal('secret:store'), field: z.string().max(200), value: z.string().max(100_000) }),
  // --- environment editor
  z.object({ type: z.literal('environment:update'), environment: EnvironmentSchema }),
  z.object({ type: z.literal('environment:save'), environment: EnvironmentSchema }),
  z.object({ type: z.literal('environment:setSecret'), key: z.string(), value: z.string().max(100_000) }),
  /** Sent when a row's secret flag is switched off or a secret row is deleted. */
  z.object({ type: z.literal('environment:deleteSecret'), key: z.string() }),
  // --- collection / folder settings
  z.object({
    type: z.literal('container:update'),
    target: z.discriminatedUnion('level', [
      z.object({ level: z.literal('collection'), collection: CollectionInfoSchema }),
      z.object({ level: z.literal('folder'), folder: FolderSchema }),
    ]),
  }),
  z.object({
    type: z.literal('container:save'),
    target: z.discriminatedUnion('level', [
      z.object({ level: z.literal('collection'), collection: CollectionInfoSchema }),
      z.object({ level: z.literal('folder'), folder: FolderSchema }),
    ]),
  }),
  // --- runner
  RunnerStartSchema,
  z.object({ type: z.literal('runner:cancel') }),
  z.object({ type: z.literal('runner:export'), format: z.enum(['json', 'html', 'junit']) }),
  z.object({ type: z.literal('runner:openRequest'), requestId: z.string() }),
]);

export type WebviewToHost = z.infer<typeof WebviewToHostSchema>;

// Re-exported for UI convenience.
export { AssertionGroupSchema, KeyValueSchema };
