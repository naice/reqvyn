import { create } from 'zustand';
import type { CodegenTarget, ExecutionResult, HostToWebview, HttpRequest, KeyValue, RequestContext, UiVariable } from '@reqvyn/core';
import { getUiState, post, setUiState } from '../../host';
import { paramsEqual, paramsFromUrl, urlFromParams } from '../../lib/url';
import { setEditorVariables } from '../../editor/variablesExt';
import type { OAuthStatus } from '../../components/AuthEditor';

export type RequestTab = 'params' | 'headers' | 'body' | 'auth' | 'cookies' | 'pre' | 'tests' | 'settings' | 'docs';
export type ResponseTab = 'body' | 'headers' | 'cookies' | 'tests' | 'timeline' | 'raw';

export interface ResponseState {
  status: 'idle' | 'loading' | 'done' | 'cancelled';
  startedAt?: number;
  result?: ExecutionResult;
}

export interface RequestStoreState {
  request: HttpRequest | null;
  context: RequestContext | null;
  dirty: boolean;
  environments: Array<{ id: string; name: string; color?: string }>;
  activeEnvironmentId: string | null;
  variables: UiVariable[];
  trusted: boolean;
  response: ResponseState;
  oauth: OAuthStatus;
  codegen: { open: boolean; target: CodegenTarget; code: string; loading: boolean };
  requestTab: RequestTab;
  responseTab: ResponseTab;
}

export const useRequestStore = create<RequestStoreState>(() => ({
  request: null,
  context: null,
  dirty: false,
  environments: [],
  activeEnvironmentId: null,
  variables: [],
  trusted: true,
  response: { status: 'idle' },
  oauth: { status: 'idle' },
  codegen: { open: false, target: getUiState<CodegenTarget>('codegenTarget', 'curl'), code: '', loading: false },
  requestTab: getUiState<RequestTab>('requestTab', 'params'),
  responseTab: getUiState<ResponseTab>('responseTab', 'body'),
}));

const set = useRequestStore.setState;
const get = useRequestStore.getState;

// ---------------------------------------------------------------------------------------------
// Draft editing (debounced request:update)
// ---------------------------------------------------------------------------------------------

const UPDATE_DELAY = 250;
let updateTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleUpdate(): void {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(flushUpdate, UPDATE_DELAY);
}

export function hasPendingUpdate(): boolean {
  return updateTimer !== undefined;
}

export function flushUpdate(): void {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = undefined;
  const r = get().request;
  if (r) post({ type: 'request:update', request: r });
}

export function editRequest(recipe: (r: HttpRequest) => HttpRequest): void {
  const r = get().request;
  if (!r) return;
  const next = recipe(r);
  if (next === r) return;
  set({ request: next, dirty: true });
  scheduleUpdate();
}

export function patchRequest(patch: Partial<HttpRequest>): void {
  editRequest((r) => ({ ...r, ...patch }));
}

/** URL edit → params table follows. */
export function setUrl(url: string): void {
  editRequest((r) => {
    if (r.url === url) return r;
    const params = paramsFromUrl(url, r.params);
    return { ...r, url, params: paramsEqual(params, r.params) ? r.params : params };
  });
}

/** Params edit → URL query string follows. */
export function setParams(params: KeyValue[]): void {
  editRequest((r) => ({ ...r, params, url: urlFromParams(r.url, params) }));
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

export function sendRequest(): void {
  const r = get().request;
  if (!r || get().response.status === 'loading') return;
  flushUpdate();
  set({ response: { ...get().response, status: 'loading', startedAt: Date.now() } });
  post({ type: 'request:send', request: r });
}

export function cancelRequest(): void {
  if (get().response.status !== 'loading') return;
  post({ type: 'request:cancel' });
}

export function saveRequest(as = false): void {
  const r = get().request;
  if (!r) return;
  flushUpdate();
  post({ type: as ? 'request:saveAs' : 'request:save', request: r });
}

export function copyAsCurl(): void {
  const r = get().request;
  if (r) post({ type: 'request:copyAsCurl', request: r });
}

export function selectEnvironment(environmentId: string | null): void {
  set({ activeEnvironmentId: environmentId });
  post({ type: 'environment:select', environmentId });
}

export function storeSecret(field: string, value: string): void {
  // Make sure the host has the latest draft before it rewrites the field to a {{$secret:...}} reference.
  flushUpdate();
  post({ type: 'secret:store', field, value });
}

export function requestCodegen(target: CodegenTarget = get().codegen.target): void {
  const r = get().request;
  if (!r) return;
  setUiState('codegenTarget', target);
  set({ codegen: { ...get().codegen, open: true, target, loading: true } });
  post({ type: 'codegen', target, request: r });
}

export function closeCodegen(): void {
  set({ codegen: { ...get().codegen, open: false } });
}

export function getOAuthToken(): void {
  const r = get().request;
  if (r) post({ type: 'oauth2:getToken', auth: r.auth });
  set({ oauth: { status: 'running', message: 'Requesting token…' } });
}

export function clearOAuthToken(): void {
  const r = get().request;
  if (r) post({ type: 'oauth2:clearToken', auth: r.auth });
}

export function setRequestTab(tab: RequestTab): void {
  set({ requestTab: tab });
  setUiState('requestTab', tab);
}

export function setResponseTab(tab: ResponseTab): void {
  set({ responseTab: tab });
  setUiState('responseTab', tab);
}

// ---------------------------------------------------------------------------------------------
// Host messages
// ---------------------------------------------------------------------------------------------

export function handleRequestMessage(msg: HostToWebview): void {
  switch (msg.type) {
    case 'request:state': {
      // Keep in-flight local edits (typed within the debounce window) instead of clobbering them.
      const keepLocal = hasPendingUpdate() && get().request?.id === msg.request.id;
      setEditorVariables(msg.variables);
      set({
        request: keepLocal ? get().request : msg.request,
        context: msg.context,
        dirty: keepLocal ? true : msg.dirty,
        environments: msg.environments,
        activeEnvironmentId: msg.activeEnvironmentId,
        variables: msg.variables,
        trusted: msg.trusted,
      });
      break;
    }
    case 'request:variables':
      setEditorVariables(msg.variables);
      set({ variables: msg.variables, activeEnvironmentId: msg.activeEnvironmentId });
      break;
    case 'request:saved':
      if (hasPendingUpdate()) set({ dirty: true });
      else set({ request: msg.request, dirty: false });
      break;
    case 'response:started':
      set({ response: { ...get().response, status: 'loading', startedAt: msg.startedAt } });
      break;
    case 'response:result':
      set({ response: { status: 'done', result: msg.result } });
      break;
    case 'response:cancelled':
      set({ response: { ...get().response, status: 'cancelled' } });
      break;
    case 'codegen:result':
      set({ codegen: { ...get().codegen, target: msg.target, code: msg.code, loading: false } });
      break;
    case 'oauth2:status':
      set({ oauth: { status: msg.status, message: msg.message, expiresAt: msg.expiresAt, userCode: msg.userCode, verificationUri: msg.verificationUri } });
      break;
    default:
      break;
  }
}
