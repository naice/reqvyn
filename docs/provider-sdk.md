# Provider SDK

`@reqvyn/provider-sdk` is the public API for writing REQVYN **sync providers**: plug-ins that store
collection snapshots somewhere, such as a server, a database, an object store or a file format.
The SDK has **no runtime dependencies**, has no `vscode` import and never contacts a REQVYN
service. REQVYN has no cloud backend. Your provider alone decides where data goes.

For what synchronization does from the user's point of view, see
[sync-providers.md](sync-providers.md). A complete, tested third-party provider (a self-hosted REST
server with a client, a reference server and contract tests) is in
[`examples/custom-sync-provider`](../examples/custom-sync-provider/README.md).

## Concepts

| Term | Meaning |
| --- | --- |
| **Provider type** | What you register: a `SyncProviderDescriptor` plus a factory (`SyncProviderFactory`). The id is `publisher.name`, for example `acme.rest`. |
| **Provider instance** | One configuration of a type ("Git: team repo", "Git: personal repo"). The user can create several instances. Each instance gets its own config, secrets and storage folder. |
| **Snapshot** (`SyncSnapshot`) | The full state of one collection: entities (`collection`, `folder`, `request`) keyed by stable id, plus tombstones for deletions. Treat it as opaque JSON: store it unchanged and return it unchanged. |
| **Manifest** (`SyncManifest`) | Revision plus entity hashes, without payloads. Used for cheap "did anything change?" checks. |
| **Revision** | An opaque string that changes whenever the stored content changes, such as a content hash, commit SHA or ETag. |

The host (`@reqvyn/sync-core`) handles everything else:

- converting collections to snapshots
- three-way merging, with field-level auto-merge
- conflict detection and resolution UI
- retries with backoff
- sync state
- secret scoping

A provider only stores and retrieves snapshots.

## The contract

```ts
interface SyncProvider {
  readonly id: string;                       // equals descriptor.id
  readonly displayName: string;
  readonly capabilities: SyncProviderCapabilities;
  initialize(context: SyncProviderContext): Promise<void>;
  authenticate?(options?: SyncOperationOptions): Promise<void>;                 // only with capabilities.auth
  getRemoteManifest(collectionId: string, options?: SyncOperationOptions): Promise<SyncManifest | null>;
  pull(collectionId: string, options?: SyncOperationOptions): Promise<SyncSnapshot | null>;
  push(collectionId: string, snapshot: SyncSnapshot, expectedRevision?: string | null, options?: SyncOperationOptions): Promise<SyncPushResult>;
  testConnection(options?: SyncOperationOptions): Promise<SyncHealthResult>;
  listRemoteCollections?(options?: SyncOperationOptions): Promise<RemoteCollectionInfo[]>;         // capabilities.list
  deleteRemoteCollection?(collectionId: string, expectedRevision?: string | null, options?: SyncOperationOptions): Promise<void>; // capabilities.delete
  dispose(): Promise<void>;                  // idempotent
}
```

Rules the engine relies on:

- **`pull` / `getRemoteManifest` return `null`** when the collection does not exist remotely. Do not
  throw `NOT_FOUND` in that case.
- **`push` and `expectedRevision`** (only when `capabilities.optimisticConcurrency` is `true`):
  - `undefined` means write unconditionally.
  - `null` means create only; the collection must not exist yet.
  - A string means write only if the current revision equals it.

  The comparison and the write must be **atomic**. On a mismatch, return
  `{ status: 'conflict', remoteRevision }` instead of throwing. The engine then re-pulls, merges and
  retries.
- **No compare-and-swap on your backend?** Then declare `optimisticConcurrency: false`. The engine
  re-reads the manifest just before pushing to make the race window smaller, but it cannot close
  it.
- **Capabilities drive behavior.** Without `write`, a provider is used for pulling only, and a
  "push" run fails with "read-only".
- **Cancellation.** Honour `options.signal` and the instance-wide `context.signal`. Use
  `throwIfCancelled(signal)`, or pass the signal to `fetch`.
- **Never leak credentials.** Secrets must not appear in error messages, `details` or log calls.
  Error messages are logged and persisted in sync state.

### Context

`initialize(context)` receives:

| Field | Description |
| --- | --- |
| `instanceId` | Id of this configured instance |
| `config` | Non-secret values, validated against your `configSchema` with defaults applied. Read them with `configString` / `configNumber` / `configBoolean`. |
| `secrets` | `get` / `set` / `delete`, scoped to **this instance**. Fields of type `secret` are stored under their `key`. Keys must match `[A-Za-z0-9_-]{1,64}`. A provider can never read REQVYN environment secrets or another instance's secrets. |
| `logger` | `debug` / `info` / `warn` / `error`; output goes to the REQVYN output channel |
| `signal` | Aborted when the instance is disposed |
| `progress` | Host-level progress reporter (phases: `connect`, `authenticate`, `pull`, `merge`, `apply`, `push`, `retry`, `done`) |
| `storagePath` | Private directory for caches or working copies. In VS Code this is `<globalStorage>/sync/<instanceId>`. |

### Descriptor and configuration schema

```ts
interface SyncProviderDescriptor {
  id: string;            // `[a-z0-9][a-z0-9._-]*`, convention `publisher.name`; must be unique
  displayName: string;
  description?: string;
  version?: string;
  capabilities: SyncProviderCapabilities; // read, write, optimisticConcurrency, list, delete, auth
  configSchema: SyncConfigField[];        // { key, label, type, required?, description?, placeholder?, default? }
}
```

- **Field types:** `string`, `number`, `boolean`, `path`, `url` and `secret`.
- **Settings UI:** REQVYN builds it from the schema, using quick inputs in VS Code.
- **Where values go:** non-secret values are stored in VS Code global state. `secret` values go to
  VS Code SecretStorage, under the instance's scope.
- **Validation:** `validateDescriptor()` validates descriptors and runs when you register.
  `validateConfigValues()` validates config values.

### Errors

Throw `new SyncProviderError(code, message, { retryable?, retryAfterMs?, status?, details?, cause? })`.
`toSyncProviderError(e)` normalizes unknown errors, and `isRetryable(e)` tells you whether an
error is retryable.

| Code | Retried by default | Use for |
| --- | --- | --- |
| `NETWORK`, `UNAVAILABLE` | yes | Transport failures, offline, 5xx, a drive that is not mounted |
| `RATE_LIMIT` | yes (after `retryAfterMs`) | Throttling |
| `AUTH` | no | Missing, invalid or expired credentials |
| `PERMISSION` | no | Authenticated but not allowed |
| `NOT_FOUND` | no | Missing resources other than the collection itself (return `null` for that) |
| `CONFLICT` | no | Prefer a `conflict` push result |
| `INVALID_DATA` | no | Corrupt or rejected payload |
| `CONFIG` | no | Bad configuration |
| `CANCELLED` | no | Aborted |
| `INTERNAL` | no | Bugs |

### Helpers

| Export | Purpose |
| --- | --- |
| `validateSnapshot(value, { collectionId?, verifyHashes?, maxEntities? })` | Structurally validate an **untrusted** snapshot read from disk or the network and verify entity hashes. Throws `INVALID_DATA`. |
| `computeSnapshotRevision(snapshot)` | Deterministic content revision. It ignores `revision`, `updatedAt` and key order. |
| `manifestFromSnapshot(snapshot, revision?, updatedAt?)` | Build a manifest from a snapshot |
| `emptySnapshot(id)`, `createEntity(kind, data)`, `hashJson(value)`, `sha256Hex(input)` | Building blocks, mostly for tests |
| `withRetry(fn, { retries, baseDelayMs, maxDelayMs, signal, onRetry })` | Exponential backoff with jitter for retryable `SyncProviderError`s; honours `retryAfterMs` |
| `throwIfCancelled(signal)`, `delay(ms, signal)` | Cancellation helpers |
| `configString` / `configNumber` / `configBoolean` | Typed config access |
| `REQVYN_EXTENSION_ID`, `REQVYN_EXTENSION_API_VERSION`, `isReqvynExtensionApi(api)` | Registration from another VS Code extension |

The host already retries whole sync runs: three retries by default, with exponential backoff.
Use `withRetry` for individual HTTP calls inside your provider.

## Example: a JSON-file provider

The provider below stores each collection as a single JSON file in a folder. It is complete and
type-checks against the SDK. It does **not** offer optimistic concurrency, because a plain file
system has no atomic compare-and-swap. That makes it fine for one writer at a time, and the
capabilities say so. For a provider with real concurrency control, retries and auth, see the REST
example, or the built-in Local Folder provider (`packages/providers/local`), which adds a lock file
and a write journal.

```ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  SyncProviderError,
  computeSnapshotRevision,
  configString,
  manifestFromSnapshot,
  sha256Hex,
  throwIfCancelled,
  validateSnapshot,
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

const capabilities: SyncProviderCapabilities = {
  read: true,
  write: true,
  optimisticConcurrency: false, // no atomic compare-and-swap on a plain folder
  list: false,
  delete: false,
  auth: false,
};

export const jsonFolderDescriptor: SyncProviderDescriptor = {
  id: 'acme.json-folder',
  displayName: 'JSON folder (example)',
  version: '0.1.0',
  capabilities,
  configSchema: [{ key: 'folder', label: 'Folder', type: 'path', required: true, description: 'Absolute path' }],
};

export class JsonFolderProvider implements SyncProvider {
  readonly id = jsonFolderDescriptor.id;
  readonly displayName = jsonFolderDescriptor.displayName;
  readonly capabilities = capabilities;
  private dir = '';

  async initialize(context: SyncProviderContext): Promise<void> {
    const folder = configString(context.config, 'folder');
    if (!folder || !path.isAbsolute(folder)) throw new SyncProviderError('CONFIG', '"folder" must be an absolute path');
    this.dir = folder;
    await fs.mkdir(folder, { recursive: true });
  }

  /** Collection ids are not guaranteed to be file-name safe: hash them. */
  private file(collectionId: string): string {
    return path.join(this.dir, `${sha256Hex(collectionId).slice(0, 32)}.json`);
  }

  async pull(collectionId: string, options?: SyncOperationOptions): Promise<SyncSnapshot | null> {
    throwIfCancelled(options?.signal);
    let text: string;
    try {
      text = await fs.readFile(this.file(collectionId), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new SyncProviderError('UNAVAILABLE', 'The sync folder cannot be read', { cause: e });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new SyncProviderError('INVALID_DATA', 'The stored snapshot is not valid JSON', { cause: e });
    }
    const snapshot = validateSnapshot(parsed, { collectionId }); // never trust what is on disk
    return { ...snapshot, revision: computeSnapshotRevision(snapshot) };
  }

  async getRemoteManifest(collectionId: string, options?: SyncOperationOptions): Promise<SyncManifest | null> {
    const snapshot = await this.pull(collectionId, options);
    return snapshot ? manifestFromSnapshot(snapshot) : null;
  }

  async push(collectionId: string, snapshot: SyncSnapshot, _expectedRevision?: string | null, options?: SyncOperationOptions): Promise<SyncPushResult> {
    throwIfCancelled(options?.signal);
    const revision = computeSnapshotRevision(snapshot);
    const updatedAt = new Date().toISOString();
    const target = this.file(collectionId);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ ...snapshot, collectionId, revision, updatedAt }), 'utf8');
      await fs.rename(tmp, target); // atomic replace: readers see the old or the new file
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw new SyncProviderError('UNAVAILABLE', 'The sync folder cannot be written', { cause: e });
    }
    return { status: 'ok', revision, updatedAt };
  }

  async testConnection(): Promise<SyncHealthResult> {
    try {
      await fs.access(this.dir);
      return { ok: true, message: `Folder ${this.dir} is reachable` };
    } catch {
      return { ok: false, message: 'The folder is not reachable', code: 'UNAVAILABLE' };
    }
  }

  async dispose(): Promise<void> {
    /* nothing to release */
  }
}

export const jsonFolderFactory: SyncProviderFactory = {
  descriptor: jsonFolderDescriptor,
  create: () => new JsonFolderProvider(),
};
```

## Registering from a VS Code extension

Your extension depends on REQVYN and registers the factory through the API that REQVYN's
`activate()` returns.

`package.json`:

```jsonc
{
  "engines": { "vscode": "^1.90.0" },
  "main": "./dist/extension.cjs",
  "extensionDependencies": ["reqvyn.reqvyn"],
  "activationEvents": ["onStartupFinished"],
  "dependencies": { "@reqvyn/provider-sdk": "…" }
}
```

`src/extension.ts`:

```ts
import * as vscode from 'vscode';
import { REQVYN_EXTENSION_ID, isReqvynExtensionApi } from '@reqvyn/provider-sdk';
import { jsonFolderFactory } from './provider.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const api: unknown = await vscode.extensions.getExtension(REQVYN_EXTENSION_ID)?.activate();
  if (!isReqvynExtensionApi(api)) {
    void vscode.window.showWarningMessage('REQVYN is not installed or too old for this sync provider.');
    return;
  }
  // Disposing unregisters the provider type (deactivation / uninstall).
  context.subscriptions.push(api.registerSyncProvider(jsonFolderFactory));
}
```

What happens next:

- **Registration:** `registerSyncProvider` throws if the descriptor is invalid or the id is
  already registered.
- **In the UI:** the provider appears under **Sync → Add Sync Provider**.
- **Isolation:** REQVYN wraps every instance in a guard (`GuardedSyncProvider`). Exceptions,
  invalid snapshots and malformed push results from your code fail only that sync run.
- **Untrusted workspaces:** providers are not used there.

Bundle the extension with esbuild and mark `vscode` as external. Bundling also pulls in the SDK.
The REST example's `package.json` shows a working build script.

> **Status:** `@reqvyn/provider-sdk` is not yet published to npm. Until it is, consume it from this
> monorepo (`"workspace:*"`, as the example does) or vendor the package.

## Trust model

- **No sandbox:** VS Code does not sandbox extensions. A provider runs in the extension host with
  the permissions of the extension that contributes it.
- **What REQVYN hands over:** each instance receives only its own configuration, its own
  namespaced secrets, and snapshots of the collections the user explicitly **assigned** to that
  instance.
- **No secret values:** snapshots never contain secret values. Collections are stored with secret
  values stripped, because those values live in VS Code SecretStorage.

## Testing a provider

`@reqvyn/sync-core` contains test utilities that need no extension host:

```ts
import { createTestProviderContext, MemoryLocalCollections, MemorySyncStateStore, SyncEngine } from '@reqvyn/sync-core';

const provider = new JsonFolderProvider();
await provider.initialize(createTestProviderContext({ folder: '/tmp/reqvyn-sync-test' }));
const result = await provider.push('c1', snapshot); // build snapshots with emptySnapshot()/createEntity()
```

Two further kinds of test are worth having:

- **End-to-end:** run a `SyncEngine` with `MemoryLocalCollections` and `MemorySyncStateStore`
  against your provider, simulating two installations.
- **Contract tests:** `examples/custom-sync-provider/test/provider.test.ts` is a contract suite
  worth copying. It covers:
  - create-only and compare-and-swap pushes
  - conflict results
  - auth errors that never contain the token
  - retries on 5xx and 429
  - timeouts and cancellation

Run tests from the repository root:

```sh
npx vitest run examples/custom-sync-provider
```
