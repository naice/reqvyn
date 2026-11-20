import * as vscode from 'vscode';
import { REQVYN_EXTENSION_API_VERSION, type ReqvynExtensionApi, type SyncProviderFactory } from '@reqvyn/provider-sdk';
import { localFolderProviderFactory } from '@reqvyn/provider-local';
import { gitProviderFactory } from '@reqvyn/provider-git';
import { VaultTokenStore, VsCodeSecretVault } from './vault.js';
import { StoreManager } from './stores.js';
import { AppState } from './state.js';
import { Services, type Log } from './services.js';
import { RESPONSE_SCHEME, ResponseDocuments } from './responses.js';
import { CollectionsTree, EnvironmentsTree, FavoritesTree, HistoryTree, type CollectionNode } from './trees.js';
import { SyncManager } from './sync.js';
import { registerCommands } from './commands.js';
import { RequestPanel, type PanelHost } from './panels/requestPanel.js';

export async function activate(context: vscode.ExtensionContext): Promise<ReqvynExtensionApi> {
  const output = vscode.window.createOutputChannel('REQVYN', { log: true });
  context.subscriptions.push(output);
  const log: Log = {
    info: (m) => output.info(m),
    warn: (m) => output.warn(m),
    error: (m) => output.error(m),
  };

  const vault = new VsCodeSecretVault(context.secrets);
  const tokenStore = new VaultTokenStore(vault);
  const stores = new StoreManager(context.globalStorageUri);
  await stores.initialize();
  const state = new AppState(context);
  const services = new Services(context, stores, state, vault, tokenStore, log);
  const responses = new ResponseDocuments();
  context.subscriptions.push(stores, state, services, responses, vscode.workspace.registerTextDocumentContentProvider(RESPONSE_SCHEME, responses));

  const host: PanelHost = { services, responses, extensionUri: context.extensionUri };

  // --- trees -----------------------------------------------------------------------------------
  const collections = new CollectionsTree(stores, state);
  const history = new HistoryTree(state);
  const environments = new EnvironmentsTree(stores, state);
  const favorites = new FavoritesTree(state);
  const collectionsView = vscode.window.createTreeView<CollectionNode>('reqvyn.collections', {
    treeDataProvider: collections,
    dragAndDropController: collections,
    canSelectMany: true,
    showCollapseAll: true,
  });
  context.subscriptions.push(
    collections,
    collectionsView,
    vscode.window.createTreeView('reqvyn.history', { treeDataProvider: history }),
    vscode.window.createTreeView('reqvyn.environments', { treeDataProvider: environments }),
    vscode.window.createTreeView('reqvyn.favorites', { treeDataProvider: favorites }),
  );

  // --- sync ------------------------------------------------------------------------------------
  const sync = new SyncManager(context, stores, vault, responses, log, async (storeId, collectionId) => {
    collections.refresh();
    await RequestPanel.reloadFromStore(storeId, collectionId);
  });
  context.subscriptions.push(sync, vscode.window.createTreeView('reqvyn.sync', { treeDataProvider: sync }));
  for (const f of [localFolderProviderFactory, gitProviderFactory]) context.subscriptions.push(sync.registry.register(f, 'builtin'));

  // --- change propagation ------------------------------------------------------------------------
  context.subscriptions.push(
    stores.onDidChange(({ storeId, event }) => {
      if (event.kind === 'collection') {
        collections.refresh();
        if (event.origin === 'external') void RequestPanel.reloadFromStore(storeId, event.id);
      } else if (event.kind === 'environment') {
        environments.refresh();
        void RequestPanel.refreshVariables();
      } else {
        collections.refresh();
        void RequestPanel.refreshVariables();
      }
    }),
    stores.onDidChangeStores(() => {
      collections.refresh();
      environments.refresh();
      sync.refresh();
      void updateContext();
    }),
    state.onDidChange((what) => {
      if (what === 'history') history.refresh();
      if (what === 'favorites') {
        favorites.refresh();
        collections.refresh();
      }
      if (what === 'environment' || what === 'globals') {
        environments.refresh();
        void RequestPanel.refreshVariables();
        void updateStatus();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void updateContext()),
  );

  // --- status bar: active environment --------------------------------------------------------
  const status = vscode.window.createStatusBarItem('reqvyn.environment', vscode.StatusBarAlignment.Left, 50);
  status.name = 'REQVYN Environment';
  context.subscriptions.push(status);
  const updateStatus = async () => {
    const entry = stores.defaultStore();
    const id = state.activeEnvironmentId(entry.id);
    const env = id ? (await stores.environments(entry.id).catch(() => [])).find((e) => e.id === id) : undefined;
    status.text = `$(globe) ${env?.name ?? 'No Environment'}`;
    status.tooltip = `REQVYN – active environment (${entry.label}). Click to change.`;
    status.command = { command: 'reqvyn.environment.select', title: 'Select environment', arguments: [entry.id] };
    status.accessibilityInformation = { label: `REQVYN environment: ${env?.name ?? 'none'}` };
    status.show();
  };
  const updateContext = async () => {
    await vscode.commands.executeCommand('setContext', 'reqvyn.hasWorkspaceStore', stores.list().some((s) => s.kind === 'workspace'));
    await vscode.commands.executeCommand('setContext', 'reqvyn.trusted', vscode.workspace.isTrusted);
  };

  registerCommands(context, { host, services, stores, state, vault, sync, trees: { collections, history, environments, favorites }, collectionsView });
  await updateContext();
  await updateStatus();
  log.info(`REQVYN ${context.extension.packageJSON.version as string} activated (${stores.list().length} store(s), trusted: ${vscode.workspace.isTrusted}).`);

  // --- public API for third-party sync providers ---------------------------------------------
  return Object.freeze({
    apiVersion: REQVYN_EXTENSION_API_VERSION,
    registerSyncProvider(factory: SyncProviderFactory) {
      const d = sync.registry.register(factory, 'extension');
      return { dispose: () => d.dispose() };
    },
  });
}

export function deactivate(): void {
  /* everything is disposed through context.subscriptions */
}
