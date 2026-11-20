import * as vscode from 'vscode';
import { secretKeys, type Auth, type CollectionInfo, type Folder, type OAuth2Config, type WebviewToHost } from '@reqvyn/core';
import { authSecretName, extractEntitySecrets } from '@reqvyn/collection-engine';
import { clearToken, getOAuth2Token } from '@reqvyn/auth-engine';
import { buildVariableContext } from '@reqvyn/runner';
import { createRequest } from '@reqvyn/core';
import { errorMessage } from '@reqvyn/shared';
import { ReqvynPanel } from '../webview.js';
import { RequestPanel, type PanelHost } from './requestPanel.js';

export interface ContainerRef {
  storeId: string;
  collectionId: string;
  /** Set for folder settings. */
  folderId?: string;
}

const keyOf = (r: ContainerRef) => `${r.storeId}|${r.collectionId}|${r.folderId ?? ''}`;

type Draft = { level: 'collection'; collection: CollectionInfo } | { level: 'folder'; folder: Folder; collectionName: string };

/** Collection / folder settings: variables, headers, auth, scripts, tests, runner defaults. */
export class ContainerPanel extends ReqvynPanel {
  private static readonly panels = new Map<string, ContainerPanel>();
  private draft!: Draft;
  private dirty = false;

  static async open(host: PanelHost, ref: ContainerRef): Promise<ContainerPanel> {
    const existing = ContainerPanel.panels.get(keyOf(ref));
    if (existing && !existing.isDisposed) {
      existing.panel.reveal();
      return existing;
    }
    const draft = await load(host, ref);
    const panel = vscode.window.createWebviewPanel('reqvyn.container', titleOf(draft), vscode.ViewColumn.Active, ReqvynPanel.options(host.extensionUri));
    const p = new ContainerPanel(panel, host, ref, draft);
    ContainerPanel.panels.set(keyOf(ref), p);
    return p;
  }

  static closeFor(storeId: string, collectionId: string, folderIds?: string[]): void {
    for (const p of ContainerPanel.panels.values()) {
      if (p.ref.storeId !== storeId || p.ref.collectionId !== collectionId) continue;
      if (!folderIds || (p.ref.folderId && folderIds.includes(p.ref.folderId))) p.dispose();
    }
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly host: PanelHost,
    private readonly ref: ContainerRef,
    draft: Draft,
  ) {
    super(panel, host.extensionUri, 'container');
    this.draft = draft;
    this.disposables.push({ dispose: () => ContainerPanel.panels.delete(keyOf(ref)) });
  }

  private get entity(): CollectionInfo | Folder {
    return this.draft.level === 'collection' ? this.draft.collection : this.draft.folder;
  }

  private setEntity(e: CollectionInfo | Folder): void {
    this.draft = this.draft.level === 'collection' ? { level: 'collection', collection: e as CollectionInfo } : { ...this.draft, folder: e as Folder };
  }

  protected async sendState(): Promise<void> {
    if (this.draft.level === 'collection') this.post({ type: 'container:state', level: 'collection', collection: this.draft.collection, dirty: this.dirty });
    else this.post({ type: 'container:state', level: 'folder', folder: this.draft.folder, collectionName: this.draft.collectionName, dirty: this.dirty });
    this.panel.title = `${this.dirty ? '● ' : ''}${titleOf(this.draft)}`;
  }

  protected async handle(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'container:update':
        this.applyTarget(msg.target);
        this.dirty = true;
        this.panel.title = `● ${titleOf(this.draft)}`;
        return;
      case 'container:save':
        this.applyTarget(msg.target);
        await this.save();
        return;
      case 'secret:store': {
        const name = authSecretName(this.entity.id, msg.field);
        await this.host.services.vault.set(secretKeys.named(name), msg.value);
        this.setEntity({ ...this.entity, auth: { ...this.entity.auth, [msg.field]: `{{$secret:${name}}}` } as Auth });
        this.dirty = true;
        await this.sendState();
        this.toast('info', 'Stored in secure storage.');
        return;
      }
      case 'oauth2:getToken':
      case 'oauth2:clearToken': {
        const auth = msg.auth as Auth;
        if (auth.type !== 'oauth2') return;
        const ctx = await this.authContext();
        if (msg.type === 'oauth2:clearToken') {
          await clearToken(auth as OAuth2Config, ctx);
          this.post({ type: 'oauth2:status', status: 'idle', message: 'Token removed.' });
          return;
        }
        this.post({ type: 'oauth2:status', status: 'running' });
        try {
          const t = await getOAuth2Token(auth as OAuth2Config, ctx, { forceNew: true });
          this.post({ type: 'oauth2:status', status: 'success', expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : undefined });
        } catch (e) {
          this.post({ type: 'oauth2:status', status: 'error', message: errorMessage(e) });
        }
        return;
      }
      case 'file:pick':
        await this.pickFile(msg.token, msg.purpose, this.host.services.stores.get(this.ref.storeId).baseDir);
        return;
      default:
        return;
    }
  }

  private applyTarget(target: Extract<WebviewToHost, { type: 'container:save' }>['target']): void {
    if (target.level === 'collection' && this.draft.level === 'collection') this.draft = { level: 'collection', collection: { ...(target.collection as CollectionInfo), id: this.ref.collectionId } };
    else if (target.level === 'folder' && this.draft.level === 'folder') this.draft = { ...this.draft, folder: { ...(target.folder as Folder), id: this.ref.folderId! } };
  }

  private async authContext() {
    const s = this.host.services;
    const collection = await s.stores.loadCollection(this.ref.storeId, this.ref.collectionId);
    const ctx = await buildVariableContext({
      collection,
      request: createRequest({ parentId: this.ref.folderId ?? null }),
      environment: await s.activeEnvironment(this.ref.storeId),
      globals: s.state.globalVariables(),
      state: s.state.variableState(this.ref.storeId),
      vault: s.vault,
    });
    const baseDir = s.stores.get(this.ref.storeId).baseDir;
    const exec = await s.executorOptions(baseDir);
    return { resolve: (t: string) => ctx.resolve(t), tokenStore: s.tokenStore, interactive: s.interactive, sendOptions: exec.send, baseDir };
  }

  private async save(): Promise<void> {
    const { store } = this.host.services.stores.get(this.ref.storeId);
    const { entity, secrets } = extractEntitySecrets(this.entity as CollectionInfo);
    for (const s of secrets) await this.host.services.vault.set(secretKeys.named(s.name), s.value);
    this.setEntity(entity);
    if (this.draft.level === 'collection') await store.saveCollectionInfo(this.draft.collection, { force: true });
    else await store.saveFolder(this.ref.collectionId, this.draft.folder, { force: true });
    this.dirty = false;
    if (secrets.length) this.toast('info', `${secrets.length} secret value(s) moved to secure storage.`);
    await this.sendState();
    await RequestPanel.reloadFromStore(this.ref.storeId, this.ref.collectionId);
    await RequestPanel.refreshVariables();
  }
}

async function load(host: PanelHost, ref: ContainerRef): Promise<Draft> {
  const c = await host.services.stores.loadCollection(ref.storeId, ref.collectionId);
  if (ref.folderId) {
    const folder = c.folders.find((f) => f.id === ref.folderId);
    if (!folder) throw new Error('The folder no longer exists.');
    return { level: 'folder', folder, collectionName: c.name };
  }
  const { folders: _f, requests: _r, ...info } = c;
  return { level: 'collection', collection: info };
}

function titleOf(d: Draft): string {
  return d.level === 'collection' ? `Collection: ${d.collection.name}` : `Folder: ${d.folder.name}`;
}
