/**
 * `@reqvyn/provider-local` – "Local Folder" sync provider. The remote is a plain directory (local
 * disk, network share, USB drive, or a folder synced by a third-party tool). Layout and crash
 * safety are provided by `@reqvyn/provider-filesystem`:
 *
 * ```text
 * <folderPath>/<collectionId>/manifest.json, entities/<id>.json, tombstones.json
 * ```
 */
import * as path from 'node:path';
import {
  SyncProviderError,
  configNumber,
  configString,
  throwIfCancelled,
  type RemoteCollectionInfo,
  type SyncHealthResult,
  type SyncManifest,
  type SyncOperationOptions,
  type SyncProvider,
  type SyncProviderCapabilities,
  type SyncProviderContext,
  type SyncProviderDescriptor,
  type SyncProviderFactory,
  type SyncPushResult,
  type SyncSnapshot,
} from '@reqvyn/provider-sdk';
import { FileSystemSyncStore, type WriteHooks } from '@reqvyn/provider-filesystem';

export const LOCAL_FOLDER_PROVIDER_ID = 'reqvyn.local-folder';

export const localFolderCapabilities: SyncProviderCapabilities = Object.freeze({
  read: true,
  write: true,
  optimisticConcurrency: true,
  list: true,
  delete: true,
  auth: false,
});

export const localFolderDescriptor: SyncProviderDescriptor = {
  id: LOCAL_FOLDER_PROVIDER_ID,
  displayName: 'Local Folder',
  description: 'Synchronize collections through a folder on this machine, a network share or a removable drive.',
  version: '0.1.0',
  capabilities: localFolderCapabilities,
  configSchema: [
    { key: 'folderPath', label: 'Folder', type: 'path', required: true, description: 'Absolute path of the shared sync folder.' },
    { key: 'lockTimeoutMs', label: 'Lock timeout (ms)', type: 'number', default: 10_000, description: 'How long to wait for another writer.' },
    { key: 'staleLockMs', label: 'Stale lock age (ms)', type: 'number', default: 30_000, description: 'A lock without heartbeat for this long is broken.' },
  ],
};

export interface LocalFolderProviderOptions {
  /** Fault-injection hooks (tests only). */
  hooks?: WriteHooks;
}

export class LocalFolderSyncProvider implements SyncProvider {
  readonly id = LOCAL_FOLDER_PROVIDER_ID;
  readonly displayName = 'Local Folder';
  readonly capabilities = localFolderCapabilities;
  private store: FileSystemSyncStore | undefined;
  private context: SyncProviderContext | undefined;

  constructor(private readonly options: LocalFolderProviderOptions = {}) {}

  async initialize(context: SyncProviderContext): Promise<void> {
    const folder = configString(context.config, 'folderPath');
    if (!folder) throw new SyncProviderError('CONFIG', 'Local Folder provider: "folderPath" is required');
    if (!path.isAbsolute(folder)) throw new SyncProviderError('CONFIG', 'Local Folder provider: "folderPath" must be an absolute path');
    this.context = context;
    this.store = new FileSystemSyncStore(path.resolve(folder), {
      lock: {
        timeoutMs: configNumber(context.config, 'lockTimeoutMs') ?? 10_000,
        staleMs: configNumber(context.config, 'staleLockMs') ?? 30_000,
      },
      hooks: this.options.hooks,
    });
  }

  private s(options?: SyncOperationOptions): FileSystemSyncStore {
    if (!this.store) throw new SyncProviderError('UNAVAILABLE', 'Provider is not initialized');
    throwIfCancelled(options?.signal);
    throwIfCancelled(this.context?.signal);
    return this.store;
  }

  private signal(options?: SyncOperationOptions): AbortSignal | undefined {
    const signals = [options?.signal, this.context?.signal].filter((s): s is AbortSignal => !!s);
    return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  }

  async getRemoteManifest(collectionId: string, options?: SyncOperationOptions): Promise<SyncManifest | null> {
    return this.s(options).readManifest(collectionId);
  }

  async pull(collectionId: string, options?: SyncOperationOptions): Promise<SyncSnapshot | null> {
    options?.progress?.report({ phase: 'pull', message: 'Reading sync folder', collectionId });
    return this.s(options).readSnapshot(collectionId, this.signal(options));
  }

  async push(collectionId: string, snapshot: SyncSnapshot, expectedRevision?: string | null, options?: SyncOperationOptions): Promise<SyncPushResult> {
    options?.progress?.report({ phase: 'push', message: 'Writing sync folder', collectionId });
    const result = await this.s(options).writeSnapshot(collectionId, snapshot, expectedRevision, this.signal(options));
    if (result.status === 'ok') this.context?.logger.debug(`local-folder: wrote ${collectionId} @ ${result.revision.slice(0, 12)}`);
    return result;
  }

  async testConnection(options?: SyncOperationOptions): Promise<SyncHealthResult> {
    return this.s(options).probe();
  }

  async listRemoteCollections(options?: SyncOperationOptions): Promise<RemoteCollectionInfo[]> {
    return this.s(options).listCollections();
  }

  async deleteRemoteCollection(collectionId: string, expectedRevision?: string | null, options?: SyncOperationOptions): Promise<void> {
    await this.s(options).deleteCollection(collectionId, expectedRevision, this.signal(options));
  }

  async dispose(): Promise<void> {
    this.store = undefined;
  }
}

export function createLocalFolderProviderFactory(options: LocalFolderProviderOptions = {}): SyncProviderFactory {
  return { descriptor: localFolderDescriptor, create: () => new LocalFolderSyncProvider(options) };
}

export const localFolderProviderFactory: SyncProviderFactory = createLocalFolderProviderFactory();
