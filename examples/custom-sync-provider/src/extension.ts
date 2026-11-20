/**
 * VS Code entry point: registers the REST provider with REQVYN. The package declares
 * `"extensionDependencies": ["naice.reqvyn"]`, so REQVYN is installed and activatable.
 */
import * as vscode from 'vscode';
import { REQVYN_EXTENSION_API_VERSION, isReqvynExtensionApi } from '@reqvyn/provider-sdk';
import { restProviderFactory } from './provider.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const api: unknown = await vscode.extensions.getExtension('naice.reqvyn')?.activate();
  if (!isReqvynExtensionApi(api)) {
    void vscode.window.showWarningMessage(
      `REST sync provider: REQVYN (extension API v${REQVYN_EXTENSION_API_VERSION}) is not available. Install or update the REQVYN extension.`,
    );
    return;
  }
  // Disposing unregisters the provider when this extension is deactivated / uninstalled.
  context.subscriptions.push(api.registerSyncProvider(restProviderFactory));
}

export function deactivate(): void {
  /* registrations are disposed through context.subscriptions */
}
