import type { HostToWebview, WebviewToHost } from '@reqvyn/core';
import { newId } from '@reqvyn/shared';

/**
 * The single bridge to the extension host. The webview only communicates through the typed
 * protocol in @reqvyn/core (`WebviewToHost` / `HostToWebview`).
 */

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

function vscode(): VsCodeApi {
  if (!api) {
    if (typeof acquireVsCodeApi === 'function') api = acquireVsCodeApi();
    else {
      // Outside VS Code (unit previews without the mock): no-op bridge.
      let state: unknown;
      api = { postMessage: (m) => console.debug('[reqvyn → host]', m), getState: () => state, setState: (s) => (state = s) };
    }
  }
  return api;
}

export function post(message: WebviewToHost): void {
  vscode().postMessage(message);
}

type Listener = (message: HostToWebview) => void;
const listeners = new Set<Listener>();
let installed = false;

export function onHostMessage(listener: Listener): () => void {
  if (!installed) {
    installed = true;
    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as unknown;
      if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') return;
      const msg = data as HostToWebview;
      if (msg.type === 'file:picked') resolvePick(msg.token, msg.path);
      for (const l of listeners) {
        try {
          l(msg);
        } catch (err) {
          console.error('[reqvyn] message handler failed', err);
        }
      }
    });
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------------------------
// File picking (file:pick → file:picked correlation by token)
// ---------------------------------------------------------------------------------------------

type PickPurpose = Extract<WebviewToHost, { type: 'file:pick' }>['purpose'];
const pendingPicks = new Map<string, (path: string | null) => void>();

export function pickFile(purpose: PickPurpose): Promise<string | null> {
  const token = newId();
  return new Promise((resolve) => {
    pendingPicks.set(token, resolve);
    post({ type: 'file:pick', token, purpose });
  });
}

function resolvePick(token: string, path: string | null): void {
  const r = pendingPicks.get(token);
  if (r) {
    pendingPicks.delete(token);
    r(path);
  }
}

export function copyToClipboard(text: string): void {
  post({ type: 'clipboard:write', text });
}

// ---------------------------------------------------------------------------------------------
// Light UI state persisted by VS Code across webview reloads (tabs, split ratio, ...)
// ---------------------------------------------------------------------------------------------

type UiState = Record<string, unknown>;
let uiState: UiState | undefined;

function loadUiState(): UiState {
  if (!uiState) {
    const s = vscode().getState();
    uiState = s && typeof s === 'object' ? { ...(s as UiState) } : {};
  }
  return uiState;
}

export function getUiState<T>(key: string, fallback: T): T {
  const v = loadUiState()[key];
  return v === undefined ? fallback : (v as T);
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function setUiState(key: string, value: unknown): void {
  const s = loadUiState();
  s[key] = value;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => vscode().setState(s), 100);
}
