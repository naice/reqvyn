import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createEnvironment, type Environment, type HistoryEntry, type KeyValue } from '@reqvyn/core';
import { CookieJar } from '@reqvyn/http-engine';
import { createVariableState, type VariableState } from '@reqvyn/runner';

export const GLOBALS_ID = 'reqvyn-globals';

export interface FavoriteRef {
  storeId: string;
  collectionId: string;
  requestId: string;
  name: string;
  method: string;
}

/**
 * Per-user application state. Nothing here is synchronized or shared:
 *  - globals (non-secret values in globalState, secret values in SecretStorage),
 *  - the active environment per store (workspaceState – a personal choice, not committed),
 *  - favorites, request history (a JSON file in global storage, with retention),
 *  - the in-memory runtime variables and cookie jar of this session.
 */
export class AppState implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<'globals' | 'environment' | 'favorites' | 'history'>();
  readonly onDidChange = this.emitter.event;
  private history: HistoryEntry[] = [];
  private historyLoaded = false;
  private historyWrite: Promise<void> = Promise.resolve();
  private readonly runtime = new Map<string, VariableState>();
  readonly cookieJar = new CookieJar();

  constructor(private readonly context: vscode.ExtensionContext) {}

  // --- globals -------------------------------------------------------------------------------

  globals(): Environment {
    const stored = this.context.globalState.get<Environment>('reqvyn.globals');
    return stored ? { ...stored, id: GLOBALS_ID } : createEnvironment({ id: GLOBALS_ID, name: 'Globals' });
  }

  globalVariables(): KeyValue[] {
    return this.globals().variables;
  }

  async saveGlobals(env: Environment): Promise<void> {
    // Secret rows never keep their value outside SecretStorage.
    const clean = { ...env, id: GLOBALS_ID, name: 'Globals', variables: env.variables.map((v) => (v.secret ? { ...v, value: '' } : v)) };
    await this.context.globalState.update('reqvyn.globals', clean);
    this.emitter.fire('globals');
  }

  // --- active environment --------------------------------------------------------------------

  activeEnvironmentId(storeId: string): string | null {
    return this.context.workspaceState.get<string | null>(`reqvyn.activeEnvironment.${storeId}`) ?? null;
  }

  async setActiveEnvironment(storeId: string, environmentId: string | null): Promise<void> {
    await this.context.workspaceState.update(`reqvyn.activeEnvironment.${storeId}`, environmentId);
    this.emitter.fire('environment');
  }

  // --- runtime variables (session only) ------------------------------------------------------

  variableState(storeId: string): VariableState {
    let s = this.runtime.get(storeId);
    if (!s) {
      s = createVariableState();
      this.runtime.set(storeId, s);
    }
    return s;
  }

  clearRuntime(): void {
    this.runtime.clear();
    this.cookieJar.clear();
  }

  // --- favorites -----------------------------------------------------------------------------

  favorites(): FavoriteRef[] {
    return this.context.globalState.get<FavoriteRef[]>('reqvyn.favorites') ?? [];
  }

  isFavorite(requestId: string): boolean {
    return this.favorites().some((f) => f.requestId === requestId);
  }

  async toggleFavorite(ref: FavoriteRef): Promise<boolean> {
    const list = this.favorites();
    const exists = list.some((f) => f.requestId === ref.requestId);
    const next = exists ? list.filter((f) => f.requestId !== ref.requestId) : [...list, ref];
    await this.context.globalState.update('reqvyn.favorites', next);
    this.emitter.fire('favorites');
    return !exists;
  }

  async pruneFavorites(isValid: (f: FavoriteRef) => boolean): Promise<void> {
    const list = this.favorites();
    const next = list.filter(isValid);
    if (next.length !== list.length) {
      await this.context.globalState.update('reqvyn.favorites', next);
      this.emitter.fire('favorites');
    }
  }

  // --- history -------------------------------------------------------------------------------

  private get historyFile(): string {
    return join(this.context.globalStorageUri.fsPath, 'history.json');
  }

  async loadHistory(): Promise<HistoryEntry[]> {
    if (!this.historyLoaded) {
      this.historyLoaded = true;
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(this.historyFile, 'utf8'));
        if (Array.isArray(parsed)) this.history = parsed as HistoryEntry[];
      } catch {
        this.history = [];
      }
    }
    return this.history;
  }

  async addHistory(entry: HistoryEntry): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('reqvyn.history');
    if (!cfg.get<boolean>('enabled', true)) return;
    const max = Math.max(1, cfg.get<number>('maxEntries', 200));
    await this.loadHistory();
    this.history = [entry, ...this.history].slice(0, max);
    this.persistHistory();
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    this.historyLoaded = true;
    this.persistHistory();
  }

  async deleteHistory(id: string): Promise<void> {
    await this.loadHistory();
    this.history = this.history.filter((h) => h.id !== id);
    this.persistHistory();
  }

  private persistHistory(): void {
    const data = JSON.stringify(this.history);
    this.historyWrite = this.historyWrite
      .then(async () => {
        await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
        await fs.writeFile(this.historyFile, data, 'utf8');
      })
      .catch(() => undefined);
    this.emitter.fire('history');
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
