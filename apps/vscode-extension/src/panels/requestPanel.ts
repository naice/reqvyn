import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { createRequest, secretKeys, type Auth, type Collection, type ExecutionResult, type HttpRequest, type HttpResponseData, type OAuth2Config, type WebviewToHost } from '@reqvyn/core';
import { authSecretName, extractEntitySecrets } from '@reqvyn/collection-engine';
import { buildVariableContext, createHistoryEntry, executeRequest } from '@reqvyn/runner';
import { clearToken, getOAuth2Token } from '@reqvyn/auth-engine';
import { exportCurl, generateCode } from '@reqvyn/import-export';
import { errorMessage, newId, toErrorJson } from '@reqvyn/shared';
import { ReqvynPanel } from '../webview.js';
import { extensionFor, responseDocument, responseText, type ResponseDocuments } from '../responses.js';
import { pickCollectionTarget } from '../pickers.js';
import type { Services } from '../services.js';

export interface RequestRef {
  storeId?: string;
  collectionId?: string;
  requestId: string;
}

export interface PanelHost {
  services: Services;
  responses: ResponseDocuments;
  extensionUri: vscode.Uri;
}

const keyOf = (r: RequestRef) => (r.collectionId ? `${r.storeId}|${r.collectionId}|${r.requestId}` : `scratch|${r.requestId}`);

/** Request editor: one panel per request. Sending, saving and secrets are handled here (host side). */
export class RequestPanel extends ReqvynPanel {
  private static readonly panels = new Map<string, RequestPanel>();

  private ref: RequestRef;
  private draft: HttpRequest;
  private dirty = false;
  private abort?: AbortController;
  private last?: { response: HttpResponseData; at: number };
  private previous?: { response: HttpResponseData; at: number };

  static async open(host: PanelHost, ref: RequestRef, initial?: HttpRequest, opts: { preview?: boolean } = {}): Promise<RequestPanel> {
    const existing = RequestPanel.panels.get(keyOf(ref));
    if (existing && !existing.isDisposed) {
      existing.panel.reveal();
      return existing;
    }
    let request = initial;
    if (!request) {
      if (!ref.storeId || !ref.collectionId) throw new Error('Request not found');
      const c = await host.services.stores.loadCollection(ref.storeId, ref.collectionId);
      request = c.requests.find((r) => r.id === ref.requestId);
      if (!request) throw new Error('The request no longer exists.');
    }
    const panel = vscode.window.createWebviewPanel('reqvyn.request', titleFor(request), { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, ReqvynPanel.options(host.extensionUri));
    const p = new RequestPanel(panel, host, ref, request, opts.preview === true);
    RequestPanel.panels.set(keyOf(ref), p);
    return p;
  }

  /** Open a new, unsaved request. */
  static openScratch(host: PanelHost, partial: Partial<HttpRequest> = {}): Promise<RequestPanel> {
    const request = createRequest({ name: 'New Request', ...partial, id: newId() });
    return RequestPanel.open(host, { requestId: request.id }, request, { preview: true });
  }

  static all(): RequestPanel[] {
    return [...RequestPanel.panels.values()].filter((p) => !p.isDisposed);
  }

  static active(): RequestPanel | undefined {
    return RequestPanel.all().find((p) => p.panel.active);
  }

  /** Re-send variables to every editor (environment switched, globals changed, …). */
  static async refreshVariables(): Promise<void> {
    await Promise.all(RequestPanel.all().map((p) => p.sendVariables().catch(() => undefined)));
  }

  /** Reload editors whose request changed on disk (unless they have unsaved changes). */
  static async reloadFromStore(storeId: string, collectionId?: string): Promise<void> {
    for (const p of RequestPanel.all()) {
      if (p.ref.storeId !== storeId || (collectionId && p.ref.collectionId !== collectionId)) continue;
      await p.reloadIfClean().catch(() => undefined);
    }
  }

  static closeFor(storeId: string, collectionId: string, requestIds?: string[]): void {
    for (const p of RequestPanel.all()) {
      if (p.ref.storeId === storeId && p.ref.collectionId === collectionId && (!requestIds || requestIds.includes(p.ref.requestId))) p.dispose();
    }
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly host: PanelHost,
    ref: RequestRef,
    request: HttpRequest,
    scratchDirty: boolean,
  ) {
    super(panel, host.extensionUri, 'request');
    this.ref = ref;
    this.draft = request;
    this.dirty = scratchDirty && !ref.collectionId;
    this.disposables.push(
      { dispose: () => this.abort?.abort() },
      { dispose: () => RequestPanel.panels.delete(keyOf(this.ref)) },
      panel.onDidChangeViewState((e) => void vscode.commands.executeCommand('setContext', 'reqvyn.requestEditorActive', e.webviewPanel.active)),
    );
  }

  get requestRef(): RequestRef {
    return this.ref;
  }

  private get services(): Services {
    return this.host.services;
  }

  private get entry() {
    return this.ref.storeId ? this.services.stores.tryGet(this.ref.storeId) : undefined;
  }

  private async collection(): Promise<Collection | undefined> {
    if (!this.ref.storeId || !this.ref.collectionId) return undefined;
    try {
      return await this.services.stores.loadCollection(this.ref.storeId, this.ref.collectionId);
    } catch {
      return undefined;
    }
  }

  /** The collection with the current draft in place of the stored request (for inheritance + variables). */
  private async collectionWithDraft(): Promise<Collection | undefined> {
    const c = await this.collection();
    if (!c) return undefined;
    const exists = c.requests.some((r) => r.id === this.draft.id);
    return { ...c, requests: exists ? c.requests.map((r) => (r.id === this.draft.id ? this.draft : r)) : [...c.requests, this.draft] };
  }

  private baseDir(): string {
    return this.entry?.baseDir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.services.context.globalStorageUri.fsPath;
  }

  private updateTitle(): void {
    this.panel.title = `${this.dirty ? '● ' : ''}${titleFor(this.draft)}`;
  }

  protected async sendState(): Promise<void> {
    const collection = await this.collectionWithDraft();
    const storeId = this.ref.storeId ?? this.services.stores.defaultStore().id;
    const environments = await this.services.stores.environments(storeId).catch(() => []);
    this.post({
      type: 'request:state',
      request: this.draft,
      context: this.services.requestContext(this.ref.storeId, collection, this.draft),
      dirty: this.dirty,
      environments: environments.map((e) => ({ id: e.id, name: e.name, color: e.color })),
      activeEnvironmentId: this.services.state.activeEnvironmentId(storeId),
      variables: await this.services.uiVariables(storeId, collection, this.draft),
      trusted: this.services.scriptsEnabled,
    });
    this.updateTitle();
  }

  async sendVariables(): Promise<void> {
    if (!this.isReady) return;
    const storeId = this.ref.storeId ?? this.services.stores.defaultStore().id;
    this.post({
      type: 'request:variables',
      variables: await this.services.uiVariables(storeId, await this.collectionWithDraft(), this.draft),
      activeEnvironmentId: this.services.state.activeEnvironmentId(storeId),
    });
  }

  private async reloadIfClean(): Promise<void> {
    if (this.dirty) return;
    const c = await this.collection();
    const r = c?.requests.find((x) => x.id === this.ref.requestId);
    if (!r) return;
    if (JSON.stringify(r) === JSON.stringify(this.draft)) return;
    this.draft = r;
    if (this.isReady) await this.sendState();
  }

  protected async handle(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'request:update':
        this.draft = msg.request as HttpRequest;
        this.dirty = true;
        this.updateTitle();
        return;
      case 'request:send':
        this.draft = msg.request as HttpRequest;
        await this.send();
        return;
      case 'request:cancel':
        this.abort?.abort();
        return;
      case 'request:save':
        this.draft = msg.request as HttpRequest;
        await this.save(false);
        return;
      case 'request:saveAs':
        this.draft = msg.request as HttpRequest;
        await this.save(true);
        return;
      case 'request:copyAsCurl': {
        const r = exportCurl(msg.request as HttpRequest, { collection: await this.collectionWithDraft() });
        await vscode.env.clipboard.writeText(r.text);
        this.toast('info', r.warnings.length ? `Copied as cURL (${r.warnings.length} value(s) replaced by placeholders).` : 'Copied as cURL.');
        return;
      }
      case 'codegen': {
        const r = generateCode(msg.target, msg.request as HttpRequest, { collection: await this.collectionWithDraft() });
        this.post({ type: 'codegen:result', target: msg.target, code: r.code });
        return;
      }
      case 'environment:select': {
        const storeId = this.ref.storeId ?? this.services.stores.defaultStore().id;
        await this.services.state.setActiveEnvironment(storeId, msg.environmentId);
        return;
      }
      case 'response:saveBody':
        await this.saveBody();
        return;
      case 'response:openInEditor':
        await this.openInEditor();
        return;
      case 'response:compare':
        await this.compare();
        return;
      case 'file:pick':
        await this.pickFile(msg.token, msg.purpose, this.baseDir());
        return;
      case 'oauth2:getToken':
        await this.oauthToken(msg.auth as Auth);
        return;
      case 'oauth2:clearToken':
        await this.oauthClear(msg.auth as Auth);
        return;
      case 'secret:store':
        await this.storeSecret(msg.field, msg.value);
        return;
      default:
        return;
    }
  }

  private async send(): Promise<void> {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const startedAt = Date.now();
    this.post({ type: 'response:started', startedAt });
    const storeId = this.ref.storeId;
    const entry = this.entry;
    const collection = await this.collectionWithDraft();
    const effectiveStore = storeId ?? this.services.stores.defaultStore().id;
    try {
      const outcome = await executeRequest(
        {
          collection,
          request: this.draft,
          environment: await this.services.activeEnvironment(effectiveStore),
          globals: this.services.state.globalVariables(),
          workspace: entry ? (await entry.store.loadConfig()).variables : undefined,
          state: this.services.state.variableState(effectiveStore),
          signal: abort.signal,
        },
        await this.services.executorOptions(this.baseDir()),
      );
      if (abort.signal.aborted && !outcome.response) {
        this.post({ type: 'response:cancelled' });
        return;
      }
      const { rawVariableChanges, durationMs: _d, ...result } = outcome;
      this.post({ type: 'response:result', result: result as ExecutionResult });
      if (outcome.response) {
        this.previous = this.last;
        this.last = { response: outcome.response, at: Date.now() };
      }
      await this.services.persistVariableChanges(storeId, this.ref.collectionId, rawVariableChanges).catch((e) => this.services.log.warn(`Persisting variables failed: ${errorMessage(e)}`));
      const ctx = await buildVariableContext({ collection, request: this.draft, environment: await this.services.activeEnvironment(effectiveStore), globals: this.services.state.globalVariables(), vault: this.services.vault });
      await this.services.state.addHistory(createHistoryEntry(this.draft, outcome, { collectionId: this.ref.collectionId, secrets: ctx.secretValues() }));
      if (rawVariableChanges.length) await RequestPanel.refreshVariables();
    } catch (e) {
      this.post({ type: 'response:result', result: { requestId: this.draft.id, requestName: this.draft.name, error: toErrorJson(e), tests: [], console: [], variableChanges: [] } });
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }

  private async save(as: boolean): Promise<void> {
    let target = this.entry && this.ref.collectionId && !as ? { entry: this.entry, collectionId: this.ref.collectionId } : undefined;
    let request = this.draft;
    if (!target) {
      const picked = await pickCollectionTarget(this.services.stores, { title: as ? 'Save request as…' : 'Save request', allowFolder: true });
      if (!picked) return;
      const name = await vscode.window.showInputBox({ title: 'Request name', value: request.name, validateInput: (v) => (v.trim() ? undefined : 'Enter a name') });
      if (!name) return;
      const siblings = picked.collection.requests.filter((r) => r.parentId === picked.folderId);
      request = { ...request, id: as || this.ref.collectionId ? newId() : request.id, name: name.trim(), parentId: picked.folderId, sortKey: Math.max(0, ...siblings.map((r) => r.sortKey)) + 1 };
      target = { entry: picked.entry, collectionId: picked.collection.id };
    }
    // Literal secrets in auth fields move to SecretStorage; the file only holds {{$secret:…}} references.
    const { entity, secrets } = extractEntitySecrets(request);
    for (const s of secrets) await this.services.vault.set(secretKeys.named(s.name), s.value);
    request = { ...entity, meta: { ...entity.meta, updatedAt: new Date().toISOString(), createdAt: entity.meta.createdAt ?? new Date().toISOString() } };
    await target.entry.store.saveRequest(target.collectionId, request, { force: true });
    const oldKey = keyOf(this.ref);
    this.ref = { storeId: target.entry.id, collectionId: target.collectionId, requestId: request.id };
    RequestPanel.panels.delete(oldKey);
    RequestPanel.panels.set(keyOf(this.ref), this);
    this.draft = request;
    this.dirty = false;
    this.post({ type: 'request:saved', request });
    if (secrets.length) this.toast('info', `${secrets.length} secret value(s) moved to secure storage.`);
    await this.sendState();
  }

  private async storeSecret(field: string, value: string): Promise<void> {
    const name = authSecretName(this.draft.id, field);
    await this.services.vault.set(secretKeys.named(name), value);
    this.draft = { ...this.draft, auth: { ...this.draft.auth, [field]: `{{$secret:${name}}}` } as Auth };
    this.dirty = true;
    await this.sendState();
    this.toast('info', 'Stored in secure storage. The request now references it as a secret.');
  }

  private async authContext() {
    const storeId = this.ref.storeId ?? this.services.stores.defaultStore().id;
    const collection = await this.collectionWithDraft();
    const ctx = await buildVariableContext({
      collection,
      request: this.draft,
      environment: await this.services.activeEnvironment(storeId),
      globals: this.services.state.globalVariables(),
      state: this.services.state.variableState(storeId),
      vault: this.services.vault,
    });
    const exec = await this.services.executorOptions(this.baseDir());
    return { resolve: (t: string) => ctx.resolve(t), tokenStore: this.services.tokenStore, interactive: this.services.interactive, sendOptions: exec.send, baseDir: this.baseDir() };
  }

  private async oauthToken(auth: Auth): Promise<void> {
    if (auth.type !== 'oauth2') return;
    this.post({ type: 'oauth2:status', status: 'running' });
    try {
      const t = await getOAuth2Token(auth as OAuth2Config, await this.authContext(), { forceNew: true });
      this.post({ type: 'oauth2:status', status: 'success', expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : undefined, message: 'Token stored in secure storage.' });
    } catch (e) {
      this.post({ type: 'oauth2:status', status: 'error', message: errorMessage(e) });
    }
  }

  private async oauthClear(auth: Auth): Promise<void> {
    if (auth.type !== 'oauth2') return;
    await clearToken(auth as OAuth2Config, await this.authContext());
    this.post({ type: 'oauth2:status', status: 'idle', message: 'Token removed.' });
  }

  private async saveBody(): Promise<void> {
    const r = this.last?.response;
    if (!r) return;
    const { ext } = extensionFor(r.contentType);
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${this.baseDir()}/response.${ext}`) });
    if (!uri) return;
    if (r.body.savedTo) await fs.copyFile(r.body.savedTo, uri.fsPath);
    else await fs.writeFile(uri.fsPath, Buffer.from(r.body.base64, 'base64'));
    if (r.body.truncated && !r.body.savedTo) this.toast('warning', 'The response was larger than the in-memory limit; only the first part was saved.');
    else this.toast('info', `Saved to ${uri.fsPath}`);
  }

  private async openInEditor(): Promise<void> {
    const r = this.last?.response;
    if (!r) return;
    const doc = await vscode.workspace.openTextDocument({ content: responseText(r), language: extensionFor(r.contentType).language });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  }

  private async compare(): Promise<void> {
    if (!this.last) return;
    if (!this.previous) {
      this.toast('info', 'Send the request again to compare two responses.');
      return;
    }
    const { ext } = extensionFor(this.last.response.contentType);
    const left = this.host.responses.put(`${this.draft.name}-previous`, ext, responseDocument(this.previous.response));
    const right = this.host.responses.put(`${this.draft.name}-latest`, ext, responseDocument(this.last.response));
    const t = (at: number) => new Date(at).toLocaleTimeString();
    await vscode.commands.executeCommand('vscode.diff', left, right, `${this.draft.name}: ${t(this.previous.at)} ↔ ${t(this.last.at)}`);
  }

  /** Programmatic send (command palette / keybinding). */
  async sendNow(): Promise<void> {
    await this.send();
  }
}

function titleFor(r: HttpRequest): string {
  return `${r.method} ${r.name}`;
}
