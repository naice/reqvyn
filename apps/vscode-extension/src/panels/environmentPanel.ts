import * as vscode from 'vscode';
import { secretKeys, type Environment, type WebviewToHost } from '@reqvyn/core';
import { ReqvynPanel } from '../webview.js';
import { GLOBALS_ID } from '../state.js';
import type { PanelHost } from './requestPanel.js';
import { RequestPanel } from './requestPanel.js';

export interface EnvironmentRef {
  /** Undefined for the global variables. */
  storeId?: string;
  environmentId: string;
}

const keyOf = (r: EnvironmentRef) => `${r.storeId ?? 'global'}|${r.environmentId}`;

/** Environment / globals editor. Secret values are never sent to the webview – only written to the vault. */
export class EnvironmentPanel extends ReqvynPanel {
  private static readonly panels = new Map<string, EnvironmentPanel>();
  private draft: Environment;
  private dirty = false;

  static async open(host: PanelHost, ref: EnvironmentRef): Promise<EnvironmentPanel> {
    const existing = EnvironmentPanel.panels.get(keyOf(ref));
    if (existing && !existing.isDisposed) {
      existing.panel.reveal();
      return existing;
    }
    const env = await load(host, ref);
    const panel = vscode.window.createWebviewPanel('reqvyn.environment', title(env, ref), vscode.ViewColumn.Active, ReqvynPanel.options(host.extensionUri));
    const p = new EnvironmentPanel(panel, host, ref, env);
    EnvironmentPanel.panels.set(keyOf(ref), p);
    return p;
  }

  static closeFor(storeId: string, environmentId: string): void {
    EnvironmentPanel.panels.get(keyOf({ storeId, environmentId }))?.dispose();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly host: PanelHost,
    private readonly ref: EnvironmentRef,
    env: Environment,
  ) {
    super(panel, host.extensionUri, 'environment');
    this.draft = env;
    this.disposables.push({ dispose: () => EnvironmentPanel.panels.delete(keyOf(ref)) });
  }

  private get isGlobal(): boolean {
    return !this.ref.storeId;
  }

  private vaultKey(key: string): string {
    return this.isGlobal ? secretKeys.globalVariable(key) : secretKeys.environmentVariable(this.ref.environmentId, key);
  }

  protected async sendState(): Promise<void> {
    this.post({ type: 'environment:state', environment: masked(this.draft), isGlobal: this.isGlobal, dirty: this.dirty });
    this.panel.title = `${this.dirty ? '● ' : ''}${title(this.draft, this.ref)}`;
  }

  protected async handle(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'environment:update':
        this.draft = masked(msg.environment as Environment);
        this.dirty = true;
        this.panel.title = `● ${title(this.draft, this.ref)}`;
        return;
      case 'environment:save':
        this.draft = masked(msg.environment as Environment);
        await this.save();
        return;
      case 'environment:setSecret':
        if (!msg.key) return;
        await this.host.services.vault.set(this.vaultKey(msg.key), msg.value);
        await RequestPanel.refreshVariables();
        return;
      case 'environment:deleteSecret':
        if (!msg.key) return;
        await this.host.services.vault.delete(this.vaultKey(msg.key));
        await RequestPanel.refreshVariables();
        return;
      default:
        return;
    }
  }

  private async save(): Promise<void> {
    const env = { ...this.draft, id: this.ref.environmentId };
    if (this.isGlobal) await this.host.services.state.saveGlobals(env);
    else await this.host.services.stores.get(this.ref.storeId!).store.saveEnvironment(env, { force: true });
    this.dirty = false;
    await this.sendState();
    await RequestPanel.refreshVariables();
  }
}

async function load(host: PanelHost, ref: EnvironmentRef): Promise<Environment> {
  if (!ref.storeId || ref.environmentId === GLOBALS_ID) return host.services.state.globals();
  const env = (await host.services.stores.environments(ref.storeId)).find((e) => e.id === ref.environmentId);
  if (!env) throw new Error('The environment no longer exists.');
  return env;
}

/** Secret rows never carry their value to the webview. */
function masked(env: Environment): Environment {
  return { ...env, variables: env.variables.map((v) => (v.secret ? { ...v, value: '' } : v)) };
}

function title(env: Environment, ref: EnvironmentRef): string {
  return ref.storeId ? `Env: ${env.name}` : 'Global Variables';
}
