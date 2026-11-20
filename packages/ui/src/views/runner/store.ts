import { create } from 'zustand';
import type { HostToWebview, RunnerConfigUi, RunnerProgress, RunnerSettings, RunSummary } from '@reqvyn/core';
import type { ReqvynErrorJson } from '@reqvyn/shared';
import { getUiState, post, setUiState } from '../../host';

export type RunResult = NonNullable<RunnerProgress['result']>;

export interface RunnerForm extends RunnerSettings {
  environmentId: string | null;
  skip: string[];
  dataFile?: string;
  persistVariables: boolean;
}

export interface RunnerStoreState {
  config: RunnerConfigUi | null;
  environments: Array<{ id: string; name: string }>;
  form: RunnerForm;
  status: 'idle' | 'running' | 'done' | 'error';
  progress: RunnerProgress | null;
  results: RunResult[];
  summary: RunSummary | null;
  error: ReqvynErrorJson | null;
  filter: 'all' | 'failed';
}

const DEFAULT_FORM: RunnerForm = { iterations: 1, delayMs: 0, concurrency: 1, stopOnFailure: false, environmentId: null, skip: [], persistVariables: false };

export const useRunnerStore = create<RunnerStoreState>(() => ({
  config: null,
  environments: [],
  form: DEFAULT_FORM,
  status: 'idle',
  progress: null,
  results: [],
  summary: null,
  error: null,
  filter: getUiState<'all' | 'failed'>('runnerFilter', 'all'),
}));

const set = useRunnerStore.setState;
const get = useRunnerStore.getState;

export function editForm(patch: Partial<RunnerForm>): void {
  set({ form: { ...get().form, ...patch } });
  const { skip, persistVariables } = { ...get().form };
  const cfg = get().config;
  if (cfg) setUiState(`runnerForm:${cfg.collectionId}:${cfg.folderId ?? ''}`, { skip, persistVariables });
}

export function toggleSkip(requestId: string, skipped: boolean): void {
  const skip = new Set(get().form.skip);
  if (skipped) skip.add(requestId);
  else skip.delete(requestId);
  editForm({ skip: [...skip] });
}

export function startRun(): void {
  const f = get().form;
  if (get().status === 'running') return;
  set({ status: 'running', results: [], summary: null, error: null, progress: null });
  post({
    type: 'runner:start',
    options: {
      iterations: Math.max(1, Math.floor(f.iterations)),
      delayMs: Math.max(0, Math.floor(f.delayMs)),
      concurrency: Math.max(1, Math.floor(f.concurrency)),
      stopOnFailure: f.stopOnFailure,
      environmentId: f.environmentId,
      skip: f.skip,
      ...(f.dataFile ? { dataFile: f.dataFile } : {}),
      persistVariables: f.persistVariables,
    },
  });
}

export function cancelRun(): void {
  if (get().status === 'running') post({ type: 'runner:cancel' });
}

export function exportRun(format: 'json' | 'html' | 'junit'): void {
  post({ type: 'runner:export', format });
}

export function openRequest(requestId: string): void {
  post({ type: 'runner:openRequest', requestId });
}

export function setFilter(filter: 'all' | 'failed'): void {
  set({ filter });
  setUiState('runnerFilter', filter);
}

export function resultFailed(r: RunResult): boolean {
  if (r.skipped) return false;
  if (r.error) return true;
  const walk = (list: RunResult['tests']): boolean => list.some((t) => (t.children?.length ? walk(t.children) : !t.passed));
  return walk(r.tests);
}

export function handleRunnerMessage(msg: HostToWebview): void {
  switch (msg.type) {
    case 'runner:config': {
      const saved = getUiState<{ skip?: string[]; persistVariables?: boolean } | undefined>(`runnerForm:${msg.config.collectionId}:${msg.config.folderId ?? ''}`, undefined);
      const ids = new Set(msg.config.requests.map((r) => r.id));
      set({
        config: msg.config,
        environments: msg.environments,
        form: {
          ...DEFAULT_FORM,
          ...msg.defaults,
          environmentId: msg.activeEnvironmentId,
          skip: (saved?.skip ?? []).filter((id) => ids.has(id)),
          persistVariables: saved?.persistVariables ?? false,
        },
      });
      break;
    }
    case 'runner:progress':
      set({
        status: 'running',
        progress: msg.progress,
        results: msg.progress.result ? [...get().results, msg.progress.result] : get().results,
      });
      break;
    case 'runner:done':
      set({ status: 'done', summary: msg.summary });
      break;
    case 'runner:error':
      set({ status: 'error', error: msg.error });
      break;
    default:
      break;
  }
}
