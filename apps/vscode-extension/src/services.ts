import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  ancestorFolders,
  resolveEffectiveConfig,
  secretKeys,
  type Collection,
  type Environment,
  type HttpRequest,
  type RequestContext,
  type SecretVault,
  type UiVariable,
  type WritableVariableScope,
} from '@reqvyn/core';
import { buildVariableContext, type ExecutorOptions } from '@reqvyn/runner';
import type { InteractiveHooks, TokenStore } from '@reqvyn/auth-engine';
import { ScriptSandboxPool } from '@reqvyn/test-engine';
import { newId } from '@reqvyn/shared';
import type { StoreManager } from './stores.js';
import type { AppState } from './state.js';

export const USER_AGENT = 'REQVYN/0.1.0 (VS Code)';

export interface Log {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Shared host services handed to panels, trees and commands. */
export class Services implements vscode.Disposable {
  private sandbox?: ScriptSandboxPool;
  private readonly onTrustEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTrust = this.onTrustEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly context: vscode.ExtensionContext,
    readonly stores: StoreManager,
    readonly state: AppState,
    readonly vault: SecretVault,
    readonly tokenStore: TokenStore,
    readonly log: Log,
  ) {
    this.disposables.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.onTrustEmitter.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('reqvyn.scripts')) void this.resetSandbox();
      }),
    );
  }

  get trusted(): boolean {
    return vscode.workspace.isTrusted;
  }

  /** Scripts run only in trusted workspaces and when not disabled by the user. */
  get scriptsEnabled(): boolean {
    return this.trusted && vscode.workspace.getConfiguration('reqvyn.scripts').get<boolean>('enabled', true);
  }

  private async resetSandbox(): Promise<void> {
    const s = this.sandbox;
    this.sandbox = undefined;
    await s?.dispose();
  }

  private sandboxPool(): ScriptSandboxPool | undefined {
    if (!this.scriptsEnabled) return undefined;
    if (!this.sandbox) {
      const cfg = vscode.workspace.getConfiguration('reqvyn.scripts');
      this.sandbox = new ScriptSandboxPool({ size: 2, memoryLimitMb: cfg.get<number>('memoryLimitMb', 64) });
    }
    return this.sandbox;
  }

  readonly interactive: InteractiveHooks = {
    openBrowser: async (url) => {
      const ok = await vscode.env.openExternal(vscode.Uri.parse(url, true));
      if (!ok) throw new Error('The browser could not be opened.');
    },
    showDeviceCode: (p) => {
      void vscode.window
        .showInformationMessage(`REQVYN OAuth 2.0: enter code ${p.userCode} at ${p.verificationUri}`, 'Copy code & open')
        .then(async (choice) => {
          if (!choice) return;
          await vscode.env.clipboard.writeText(p.userCode);
          await vscode.env.openExternal(vscode.Uri.parse(p.verificationUriComplete ?? p.verificationUri, true));
        });
    },
  };

  /** Executor options derived from the user's settings. TLS verification is only disabled explicitly. */
  async executorOptions(baseDir: string): Promise<ExecutorOptions> {
    const http = vscode.workspace.getConfiguration('reqvyn.http');
    const proxyUrl = http.get<string>('proxy', '') || vscode.workspace.getConfiguration('http').get<string>('proxy', '') || undefined;
    const noProxy = http.get<string[]>('noProxy', []);
    const verify = http.get<boolean>('verifyTls', true);
    const caFiles = http.get<string[]>('caCertificates', []);
    const ca: string[] = [];
    for (const f of caFiles) {
      const p = isAbsolute(f) ? f : join(baseDir, f);
      try {
        ca.push(await fs.readFile(p, 'utf8'));
      } catch {
        this.log.warn(`CA certificate "${f}" could not be read.`);
        void vscode.window.showWarningMessage(`REQVYN: CA certificate "${f}" could not be read.`);
      }
    }
    if (!verify) this.log.warn('TLS certificate verification is disabled by the setting reqvyn.http.verifyTls.');
    return {
      vault: this.vault,
      tokenStore: this.tokenStore,
      interactive: this.interactive,
      sandbox: this.sandboxPool(),
      scripts: { enabled: this.scriptsEnabled, timeoutMs: vscode.workspace.getConfiguration('reqvyn.scripts').get<number>('timeoutMs', 5000) },
      baseDir,
      processEnv: vscode.workspace.getConfiguration('reqvyn').get<boolean>('allowProcessEnv', true) ? { ...process.env } : undefined,
      send: {
        timeoutMs: http.get<number>('timeoutMs', 30000),
        followRedirects: http.get<boolean>('followRedirects', true),
        maxRedirects: http.get<number>('maxRedirects', 10),
        maxBodyBytes: http.get<number>('maxResponseMb', 50) * 1024 * 1024,
        proxy: proxyUrl ? { url: proxyUrl, noProxy } : undefined,
        tls: { ...(verify ? {} : { verify: false }), ...(ca.length ? { ca } : {}) },
        cookieJar: http.get<boolean>('cookieJar', true) ? this.state.cookieJar : undefined,
        userAgent: USER_AGENT,
      },
    };
  }

  /** Environment selected for a store (or null). */
  async activeEnvironment(storeId: string): Promise<Environment | null> {
    const id = this.state.activeEnvironmentId(storeId);
    if (!id) return null;
    const entry = this.stores.tryGet(storeId);
    if (!entry) return null;
    return (await entry.store.listEnvironments()).find((e) => e.id === id) ?? null;
  }

  /** Masked variable list for the request editor (autocomplete, hover). */
  async uiVariables(storeId: string | undefined, collection: Collection | undefined, request: HttpRequest): Promise<UiVariable[]> {
    const entry = storeId ? this.stores.tryGet(storeId) : undefined;
    const config = entry ? await entry.store.loadConfig().catch(() => undefined) : undefined;
    const ctx = await buildVariableContext({
      collection,
      request,
      environment: storeId ? await this.activeEnvironment(storeId) : null,
      globals: this.state.globalVariables(),
      workspace: config?.variables,
      state: storeId ? this.state.variableState(storeId) : undefined,
      vault: this.vault,
    });
    return ctx.toUiVariables();
  }

  /** Context shown above the request editor (breadcrumb, inherited headers/auth). */
  requestContext(storeId: string | undefined, collection: Collection | undefined, request: HttpRequest): RequestContext {
    if (!collection) {
      return { path: [], inheritedHeaders: [], inheritedAuth: { type: 'none', source: '' }, scratch: true };
    }
    const folders = ancestorFolders(collection, request.parentId);
    const inheritedHeaders: RequestContext['inheritedHeaders'] = [];
    for (const h of collection.headers) if (h.enabled && h.key) inheritedHeaders.push({ key: h.key, value: h.secret ? '••••••' : h.value, source: collection.name });
    for (const f of folders) for (const h of f.headers) if (h.enabled && h.key) inheritedHeaders.push({ key: h.key, value: h.secret ? '••••••' : h.value, source: f.name });
    const eff = resolveEffectiveConfig(collection, { ...request, auth: { type: 'inherit' } });
    return {
      storeId,
      collectionId: collection.id,
      collectionName: collection.name,
      path: folders.map((f) => f.name),
      inheritedHeaders,
      inheritedAuth: { type: eff.auth.type, source: eff.authSource.name },
      scratch: false,
    };
  }

  /**
   * Persist variable changes made by scripts/extractions. Runtime values stay in memory; environment,
   * collection and global values are written back (secret rows go to the vault only).
   */
  async persistVariableChanges(
    storeId: string | undefined,
    collectionId: string | undefined,
    changes: Array<{ scope: WritableVariableScope; key: string; value: string | null }>,
  ): Promise<void> {
    if (!changes.length) return;
    const entry = storeId ? this.stores.tryGet(storeId) : undefined;
    let env: Environment | null = null;
    let envDirty = false;
    let collection: Collection | undefined;
    let collectionDirty = false;
    let globals = this.state.globals();
    let globalsDirty = false;

    // `vaultKey` undefined: secret rows of this scope are not persisted (session state only).
    const apply = async (rows: Environment['variables'], key: string, value: string | null, vaultKey: string | undefined): Promise<Environment['variables']> => {
      const idx = rows.findIndex((r) => r.key === key);
      if (value === null) {
        if (idx >= 0 && rows[idx]!.secret) {
          if (vaultKey) await this.vault.delete(vaultKey);
          else return rows;
        }
        return idx >= 0 ? rows.filter((_, i) => i !== idx) : rows;
      }
      if (idx >= 0) {
        const row = rows[idx]!;
        if (row.secret) {
          if (vaultKey) await this.vault.set(vaultKey, value);
          return rows;
        }
        return rows.map((r, i) => (i === idx ? { ...r, value } : r));
      }
      return [...rows, { id: newId(), key, value, enabled: true, secret: false }];
    };

    for (const c of changes) {
      if (c.scope === 'runtime') continue;
      if (c.scope === 'environment' && entry && storeId) {
        env ??= await this.activeEnvironment(storeId);
        if (!env) continue;
        env = { ...env, variables: await apply(env.variables, c.key, c.value, secretKeys.environmentVariable(env.id, c.key)) };
        envDirty = true;
      } else if (c.scope === 'collection' && entry && collectionId) {
        collection ??= await entry.store.loadCollection(collectionId);
        collection = { ...collection, variables: await apply(collection.variables, c.key, c.value, undefined) };
        collectionDirty = true;
      } else if (c.scope === 'global') {
        globals = { ...globals, variables: await apply(globals.variables, c.key, c.value, secretKeys.globalVariable(c.key)) };
        globalsDirty = true;
      }
    }
    if (envDirty && env && entry) await entry.store.saveEnvironment(env, { force: true });
    if (collectionDirty && collection && entry) {
      const { folders: _f, requests: _r, ...info } = collection;
      await entry.store.saveCollectionInfo(info, { force: true });
    }
    if (globalsDirty) await this.state.saveGlobals(globals);
  }

  dispose(): void {
    void this.resetSandbox();
    this.onTrustEmitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
