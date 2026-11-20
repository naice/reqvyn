# Custom sync provider example: self-hosted REST

This folder is a complete third-party REQVYN sync provider, packaged as its own VS Code extension.
It contains:

| File | Purpose |
| --- | --- |
| `src/provider.ts` | `RestSyncProvider`: the `SyncProvider` implementation, its descriptor and factory |
| `src/extension.ts` | VS Code entry point that registers the factory with REQVYN |
| `src/server.ts` | Reference REST server (`node:http`, in-memory) implementing the protocol |
| `test/provider.test.ts` | Contract tests: concurrency, retries, auth, timeouts, end-to-end with the engine |

Third-party providers depend only on **`@reqvyn/provider-sdk`**. The SDK has no runtime
dependencies, and nothing in it talks to a REQVYN service. REQVYN has no cloud backend and sends
no telemetry. Your provider decides where data goes.

## 1. Implement `SyncProvider`

```ts
import type { SyncProvider, SyncProviderContext, SyncSnapshot } from '@reqvyn/provider-sdk';

class MyProvider implements SyncProvider {
  readonly id = 'acme.my-provider';            // must equal descriptor.id
  readonly displayName = 'Acme storage';
  readonly capabilities = { read: true, write: true, optimisticConcurrency: true, list: true, delete: true, auth: false };
  async initialize(ctx: SyncProviderContext) { /* validate ctx.config, read ctx.secrets */ }
  async getRemoteManifest(id: string) { /* cheap revision check, null if missing */ }
  async pull(id: string) { /* SyncSnapshot | null */ }
  async push(id: string, snap: SyncSnapshot, expectedRevision?: string | null) { /* SyncPushResult */ }
  async testConnection() { /* { ok, message, code? } */ }
  async dispose() {}
}
```

Semantics the engine relies on:

- **Snapshots are opaque JSON.** Store `snapshot` exactly as given and return it from `pull`.
  `validateSnapshot()` checks untrusted input, `computeSnapshotRevision()` gives a content
  revision, and `manifestFromSnapshot()` builds the manifest.
- **Optimistic concurrency.** `expectedRevision` works as follows:
  - `undefined` means write unconditionally.
  - `null` means write only if the collection does not exist yet.
  - A string means write only if the current revision equals it.

  On a mismatch, return `{ status: 'conflict', remoteRevision }`; do not throw. The engine then
  re-pulls, merges and retries. Without a real compare-and-swap on your backend, set
  `optimisticConcurrency: false`.
- **Revisions** are opaque strings that change whenever the content changes. Examples are an ETag,
  a commit hash or a content hash.
- **Cancellation.** Honour `options.signal` and `ctx.signal`. `AbortSignal.any([...])` combines
  them.

## 2. Describe it (descriptor + factory)

```ts
export const descriptor: SyncProviderDescriptor = {
  id: 'acme.my-provider',                       // lowercase, dotted: publisher.name
  displayName: 'Acme storage',
  capabilities: { ... },
  configSchema: [
    { key: 'baseUrl', label: 'Server URL', type: 'url', required: true },
    { key: 'token', label: 'API token', type: 'secret', required: true },
  ],
};
export const factory: SyncProviderFactory = { descriptor, create: () => new MyProvider() };
```

REQVYN renders the settings UI from `configSchema` and validates it with `validateDescriptor` /
`validateConfigValues`. Config fields have the types `string`, `number`, `boolean`, `path`, `url`
and `secret`.

## 3. Secrets

- Values of fields with `type: 'secret'` never appear in `ctx.config`. Read them with
  `await ctx.secrets.get('token')`.
- The storage is scoped to **your provider instance**. A provider cannot read REQVYN's
  environment secrets or another provider's credentials.
- Never put secrets in error messages or logs. The example redacts the token from any server
  response text before it ends up in an error.
- Refuse credentials embedded in URLs.
- Refuse plain `http://` except for loopback addresses.

## 4. Errors

Throw `new SyncProviderError(code, message, { retryable?, retryAfterMs?, cause? })`. The engine
uses the code to decide what happens next:

| Code | Meaning | Engine behaviour |
| --- | --- | --- |
| `NETWORK`, `UNAVAILABLE` | Transport failure, offline, 5xx, missing drive | Retried with backoff; local data is kept |
| `RATE_LIMIT` | Throttled | Retried after `retryAfterMs` |
| `AUTH` | Missing or expired credentials | Not retried; the user re-authenticates |
| `PERMISSION` | Authenticated but not allowed | Not retried |
| `NOT_FOUND` | Remote resource missing | `getRemoteManifest`/`pull` should return `null` instead |
| `CONFLICT` | A concurrent writer won | Prefer a `conflict` push result |
| `INVALID_DATA` | Corrupt or rejected payload | Not retried |
| `CONFIG` | Bad configuration | Not retried; shown in settings |
| `CANCELLED` | Aborted | Run reported as `cancelled` |
| `INTERNAL` | Bug | Not retried |

`withRetry()` from the SDK gives you provider-level retries for individual HTTP calls. The engine
also retries whole sync runs.

## 5. Register from a VS Code extension

`package.json`:

```jsonc
{
  "extensionDependencies": ["naice.reqvyn"],   // REQVYN is installed and activated first
  "activationEvents": ["onStartupFinished"],
  "dependencies": { "@reqvyn/provider-sdk": "^1.0.0" }
}
```

`src/extension.ts`:

```ts
const api = await vscode.extensions.getExtension('naice.reqvyn')?.activate();
if (isReqvynExtensionApi(api)) context.subscriptions.push(api.registerSyncProvider(factory));
```

The returned `Disposable` unregisters the provider when your extension is deactivated or
uninstalled. REQVYN isolates provider exceptions: a crash in your code fails that sync run and
does not affect REQVYN. REQVYN also validates every snapshot and push result you return.

## 6. Test it

`createTestProviderContext(config, { secrets })` from `@reqvyn/sync-core` builds a context without
the extension host:

```ts
const p = new MyProvider();
await p.initialize(createTestProviderContext({ baseUrl }, { secrets: { token: 't' } }));
```

`test/provider.test.ts` shows contract tests worth copying:

- create-only (`null`) and compare-and-swap pushes
- conflict results
- `AUTH` mapping, and checking that the token never appears in errors
- retrying 5xx, 429 with `Retry-After`, and dropped connections
- timeouts and cancellation
- a two-installation sync through `SyncEngine`

Run them from the repository root:

```sh
npx vitest run examples/custom-sync-provider
```

Run the reference server manually:

```sh
REQVYN_SYNC_TOKEN=change-me PORT=8787 node --experimental-strip-types src/server.ts
```

The server keeps data **in memory**. For real use:

- Back it with durable storage.
- Keep the revision check and the write atomic, for example with a transaction or a conditional
  update.
- Put it behind HTTPS.

### REST protocol

All endpoints except `/health` require `Authorization: Bearer <token>`.

| Method and path | Description |
| --- | --- |
| `GET /health` | Liveness check (no auth) |
| `GET /collections` | `[{ collectionId, label, revision, updatedAt }]` |
| `GET /collections/:id/manifest` | Manifest. `ETag` is the revision; 404 if missing |
| `GET /collections/:id/snapshot` | Snapshot. `ETag` is the revision; 404 if missing |
| `PUT /collections/:id/snapshot` | Body is the snapshot. Send `If-None-Match: *` (create) or `If-Match: "<rev>"`. Returns 201/200 `{ revision, updatedAt }`; 412 `{ currentRevision }` on mismatch; 422 for an invalid snapshot |
| `DELETE /collections/:id` | Optional `If-Match`; returns 204 |

## 7. Build and publish

1. Run `npm run build`. It bundles `src/extension.ts` with esbuild into `dist/extension.cjs`, with
   `vscode` external. Bundling also pulls in the SDK.
2. Run `npx @vscode/vsce package`, then `npx @vscode/vsce publish` (or `npx ovsx publish` for Open
   VSX).
3. Use your own publisher id and provider id prefix (`<publisher>.<name>`). REQVYN rejects
   duplicate provider ids.
4. Declare the SDK range you support. REQVYN checks `apiVersion` on the extension API
   (`REQVYN_EXTENSION_API_VERSION`).
