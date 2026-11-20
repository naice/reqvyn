import { create } from 'zustand';
import type { Environment, HostToWebview, KeyValue } from '@reqvyn/core';
import { post } from '../../host';
import { changedSecrets } from '../../lib/bulk';

export interface EnvironmentStoreState {
  environment: Environment | null;
  isGlobal: boolean;
  dirty: boolean;
}

export const useEnvironmentStore = create<EnvironmentStoreState>(() => ({ environment: null, isGlobal: false, dirty: false }));

const set = useEnvironmentStore.setState;
const get = useEnvironmentStore.getState;

const UPDATE_DELAY = 300;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Plaintext secret values typed in this webview that still have to be handed to the host. */
const pendingSecrets = new Map<string, string>();
/** Last secret value sent per key — avoids re-sending while bulk text is unchanged. */
const sentSecrets = new Map<string, string>();
/** Host-provided (masked) values of secret rows, by row id. */
let maskedValues = new Map<string, string>();

function rememberMasked(env: Environment): void {
  maskedValues = new Map(env.variables.filter((v) => v.secret).map((v) => [v.id, v.value]));
}

/** Environment payload for the host: secret rows never carry plaintext typed in the webview. */
function sanitized(env: Environment): Environment {
  return { ...env, variables: env.variables.map((v) => (v.secret ? { ...v, value: maskedValues.get(v.id) ?? '' } : v)) };
}

export function hasPendingEnvUpdate(): boolean {
  return timer !== undefined;
}

export function flushEnvUpdate(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const env = get().environment;
  if (!env) return;
  for (const [key, value] of pendingSecrets) {
    if (sentSecrets.get(key) === value) continue;
    post({ type: 'environment:setSecret', key, value });
    sentSecrets.set(key, value);
  }
  pendingSecrets.clear();
  const clean = sanitized(env);
  set({ environment: clean });
  post({ type: 'environment:update', environment: clean });
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(flushEnvUpdate, UPDATE_DELAY);
}

export function editEnvironment(patch: Partial<Environment>): void {
  const env = get().environment;
  if (!env) return;
  set({ environment: { ...env, ...patch }, dirty: true });
  schedule();
}

/** Table/bulk edits. Secret values changed in bulk mode are routed to environment:setSecret. */
export function setVariables(next: KeyValue[]): void {
  const env = get().environment;
  if (!env) return;
  for (const s of changedSecrets(env.variables, next)) {
    pendingSecrets.set(s.key, s.value);
  }
  editEnvironment({ variables: next });
}

/** Mark a row secret (moving its current plaintext into SecretStorage) or back to a plain variable. */
export function toggleSecret(row: KeyValue, secret: boolean): void {
  const env = get().environment;
  if (!env) return;
  if (secret) {
    if (row.key && row.value) pendingSecrets.set(row.key, row.value);
    maskedValues.set(row.id, '');
  } else {
    maskedValues.delete(row.id);
  }
  editEnvironment({ variables: env.variables.map((v) => (v.id === row.id ? { ...v, secret, value: secret ? v.value : '' } : v)) });
  if (secret) flushEnvUpdate();
}

export function setSecretValue(key: string, value: string): void {
  if (!key) return;
  flushEnvUpdate();
  post({ type: 'environment:setSecret', key, value });
  sentSecrets.set(key, value);
}

export function saveEnvironment(): void {
  if (!get().environment) return;
  flushEnvUpdate();
  post({ type: 'environment:save', environment: get().environment! });
}

export function handleEnvironmentMessage(msg: HostToWebview): void {
  if (msg.type !== 'environment:state') return;
  const keepLocal = hasPendingEnvUpdate() && get().environment?.id === msg.environment.id;
  rememberMasked(msg.environment);
  if (keepLocal) {
    set({ isGlobal: msg.isGlobal, dirty: true });
    return;
  }
  set({ environment: msg.environment, isGlobal: msg.isGlobal, dirty: msg.dirty });
}
