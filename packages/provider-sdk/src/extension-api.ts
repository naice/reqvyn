import type { SyncProviderFactory } from './types.js';

/** VS Code-compatible disposable (structurally identical to `vscode.Disposable`). */
export interface Disposable {
  dispose(): void;
}

/** Marketplace id of the REQVYN extension. */
export const REQVYN_EXTENSION_ID = 'naice.reqvyn';

/** Current version of {@link ReqvynExtensionApi}. */
export const REQVYN_EXTENSION_API_VERSION = 1 as const;

/**
 * API returned by `vscode.extensions.getExtension('naice.reqvyn')?.activate()`.
 *
 * Trust model: providers run in the extension host with the permissions of the contributing
 * extension (VS Code does not sandbox extensions). REQVYN only hands each provider instance its
 * own configuration, its own namespaced secrets and the snapshots of collections the user has
 * explicitly assigned to it. Providers are disabled in untrusted workspaces.
 */
export interface ReqvynExtensionApi {
  readonly apiVersion: typeof REQVYN_EXTENSION_API_VERSION;
  /**
   * Register a provider type. Throws if the descriptor is invalid or the id is already taken.
   * Dispose the returned object (e.g. via `context.subscriptions`) to unregister.
   */
  registerSyncProvider(factory: SyncProviderFactory): Disposable;
}

/** Type guard for an object returned by `activate()` of the REQVYN extension. */
export function isReqvynExtensionApi(value: unknown): value is ReqvynExtensionApi {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { apiVersion?: unknown }).apiVersion === REQVYN_EXTENSION_API_VERSION &&
    typeof (value as { registerSyncProvider?: unknown }).registerSyncProvider === 'function'
  );
}
