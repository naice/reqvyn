# REQVYN Architecture

This document describes how REQVYN is structured, why it is built that way, and how its features map to Thunder Client, which served as a functional reference. No Thunder Client code, assets or wording were reused.

## Guiding principles

1. **Local-first.** All data lives on the user's machine. There is no hosted REQVYN service, account or telemetry. Network traffic happens only for requests the user sends and for sync providers the user configures.
2. **Engines are independent of VS Code.** Everything except `apps/vscode-extension` and `packages/ui` is plain Node.js/TypeScript. The CLI, the MCP server and the extension share the same collection, environment, HTTP, auth, test and runner engines, so a collection behaves the same in the editor and in CI.
3. **The webview only presents.** The React UI renders state and sends typed messages. It never reads files, accesses secrets or performs network requests. All effects happen in the extension host.
4. **Secrets never touch files.** Secret values live in a `SecretVault` (VS Code SecretStorage in the extension, `REQVYN_SECRET_*` environment variables in the CLI). Collection files hold `{{$secret:name}}` references.
5. **Validate at every boundary.** Files, imports, webview messages, sync payloads and provider configs are parsed with Zod schemas (`@reqvyn/core`) before use.

## Repository layout

```text
apps/vscode-extension/      VS Code integration: activation, trees, commands, panels, SecretStorage vault
packages/
  shared/                   ids, errors (ReqvynError), redaction helpers, no dependencies
  core/                     Zod models (collections, requests, auth, assertions, environments),
                            factories, tree helpers, webview protocol, storage interfaces
  collection-engine/        FileSystemStore (.reqvyn/, one file per request), MemoryStore,
                            atomic writes, file locks, secret stripping and extraction
  environment-engine/       variable resolution, precedence, dynamic variables, {{$secret:…}}
  http-engine/              node:http(s) transport, proxy/no-proxy, TLS/CA/client certs,
                            cookies, redirects, decompression, timings, size limits
  auth-engine/              Basic, Bearer, API key, Digest, JWT, AWS SigV4, client certs, OAuth 2.0
  test-engine/              scriptless assertions and extractions, sandboxed script worker
  runner/                   collection runner (iterations, data files, concurrency), JSON/HTML/JUnit reports
  import-export/            importers, exporters, codegen, .reqvyn ZIP packages, OpenAPI refresh
  sync-core/                SyncEngine (three-way merge, conflicts, state), provider registry with guards
  provider-sdk/             public types for sync providers (no runtime dependencies)
  providers/filesystem/     shared file layout, locking and atomic writes for file-based providers
  providers/local/          sync with a local or network folder
  providers/git/            sync through a Git repository (system git; token via GIT_CONFIG_* env)
  ui/                       React + Vite + Zustand webview bundle (request, environment, runner, settings views)
  cli/                      `reqvyn` CLI and optional MCP server
examples/custom-sync-provider/   working third-party provider, with tests
tests/                      cross-package integration tests (sync between two installations, failures)
docs/                       user and developer documentation
```

### Dependency graph

```text
shared ← core ← collection-engine
             ← environment-engine
             ← http-engine ← auth-engine
             ← test-engine
             ← runner (http, environment, auth, test)
             ← import-export
             ← sync-core ← provider-sdk (types only)
provider-sdk ← providers/filesystem ← providers/local, providers/git
cli          → runner, import-export, collection-engine, …
ui           → core, shared (browser-safe parts only)
vscode-extension → all of the above
```

`provider-sdk` has no runtime dependencies, so third-party providers can depend on it without pulling in REQVYN internals.

## Key flows

### Sending a request

1. The webview posts `request:send` with its current draft. The message is validated against `WebviewToHostSchema`.
2. `Services` (in the extension) builds the variable context. It loads globals, the collection, the active environment and runtime variables, prefetches the `{{$secret:…}}` values the request references from the vault, and resolves inherited auth, headers and scripts from folders and the collection.
3. If scripts are enabled and the workspace is trusted, the pre-request script runs in the sandbox worker.
4. `auth-engine` applies authentication. OAuth 2.0 tokens are cached in the vault through `VaultTokenStore`.
5. `http-engine` sends the request with proxy, TLS and cookie settings, and records timings and a timeline.
6. `test-engine` runs assertions, extractions (which chain values into runtime or environment variables) and the test script.
7. The result goes back to the webview, and the history entry is stored with sensitive headers and values redacted.

### Storage

`FileSystemStore` writes `.reqvyn/` with one JSON file per collection, folder, request and environment (see [docs/storage-format.md](docs/storage-format.md)). Writes are atomic: the store writes a temp file, then renames it, under a lock file. A file watcher reports external changes, for example from `git pull`, as `origin: 'external'` events, so open panels reload. Without a workspace folder, a personal store in the extension's global storage is used.

### Sync

`SyncEngine` keeps a base snapshot for each collection and performs a three-way merge between base, local and remote. When both sides changed the same entity differently, it reports a conflict with the changed fields. The user resolves each conflict by choosing local or remote, with a diff view. Providers are wrapped by a guard in the registry, which validates configs, enforces timeouts, handles cancellation and sanitizes errors. Provider secrets are stored per instance in SecretStorage and are never passed through settings or globalState. See [docs/sync-providers.md](docs/sync-providers.md) and [docs/provider-sdk.md](docs/provider-sdk.md).

### Scripts

Scripts run in a `worker_threads` worker with `resourceLimits` that set the memory limit. Inside the worker, each script runs in a fresh `vm` context with a null prototype. String code generation (`eval`, `new Function`) and WebAssembly are disabled, and `require` and dangerous `process` members are removed. Each run has a timeout, and a runaway worker is terminated. Scripts get only the documented API (request, response, variables, assertions); they have no file system or network access. Scripts never run in untrusted workspaces, and the CLI can disable them with `--no-scripts`.

> Node's `vm` module is not a hard security boundary against hostile code. REQVYN treats scripts as user-authored code from trusted workspaces. The isolation protects against accidental damage and limits what an imported collection can do, but it is not designed to contain a deliberate attacker. See [SECURITY.md](SECURITY.md).

### Webview

Each panel's HTML uses a CSP with `default-src 'none'`, nonce-only scripts, `connect-src 'none'` and local resources only. React needs `'unsafe-inline'` for style attributes, which is allowed for styles but never for scripts. Messages in both directions follow the Zod protocol in `@reqvyn/core`. Styling uses VS Code theme variables first; the REQVYN brand colours are accents only.

## Extension points

| Extension point | Interface | Notes |
| --- | --- | --- |
| Storage engine | `CollectionStore` (`@reqvyn/core`) | `FileSystemStore` and `MemoryStore` are provided |
| Secret storage | `SecretVault` (`@reqvyn/core`) | SecretStorage, environment variables (CLI) and memory (tests) |
| Request transport | `HttpTransport` (`@reqvyn/http-engine`) | Injected through `ExecutorOptions.transport`; the default is `NodeHttpTransport` (node:http(s)) |
| Sync provider | `SyncProviderFactory` (`@reqvyn/provider-sdk`) | Other extensions register through the API returned by `activate()`: `registerSyncProvider(factory)` |
| Importer | `importText` / `importFiles` with format detection | New formats are added in `import-export/src/importers` |

## Testing strategy

- **Unit tests (Vitest):** each package has its own tests: models, resolver, transport against a local HTTP/HTTPS server, auth signatures against reference vectors, sandbox limits, importer fixtures, ZIP hardening, the merge engine and the git provider against real local repositories.
- **Integration tests (`tests/`):** two simulated installations sync through local and git providers, plus failure injection (crash between writes, timeouts, corrupted remote).
- **Extension unit tests (`apps/vscode-extension/test/unit`):** pure helpers run against a small `vscode` mock: vaulting secrets on import, CSP shell, response documents and folder paths.
- **Activation smoke test:** the bundled `dist/extension.cjs` is activated with a mocked `vscode` API, and every declared command is checked to be registered and the other way round. This test is run manually and is not yet part of CI (see [docs/development.md](docs/development.md)).

There are no end-to-end UI tests yet (for example with `@vscode/test-electron`). See *Next steps*.

## Feature matrix

This matrix compares REQVYN with Thunder Client, based on Thunder Client's public documentation (docs.thunderclient.com). It describes behaviour, not implementation.

Status: ✅ implemented and tested · 🟡 partial or different behaviour · ❌ not implemented

### Requests and responses

| Thunder Client capability | REQVYN | Status | Notes / differences |
| --- | --- | --- | --- |
| HTTP methods, query params, headers | Request editor with key/value tables and bulk edit | ✅ | URL and param table stay in sync |
| Body: JSON, XML, text, form-encoded, multipart, binary | All body modes | ✅ | Multipart supports files |
| GraphQL requests | GraphQL body with query and variables editors | 🟡 | No schema introspection or autocompletion |
| Response viewer (JSON, HTML preview, headers, cookies) | Pretty JSON, tree view, sandboxed HTML preview, headers, cookies, timings | ✅ | HTML preview runs in a sandboxed frame without network access |
| Save response to file | Open response in an editor, then save | 🟡 | Uses VS Code's editor instead of a dedicated button |
| Compare responses | Diff of the last two responses in VS Code's diff view | ✅ | |
| Code snippets | cURL, fetch (JS/TS/Node), Python requests, C# HttpClient, PowerShell | ✅ | Secrets are rendered as placeholders |
| Cookie management | Session cookie jar; clear through **Clear Runtime Variables and Cookies** | 🟡 | No cookie editor UI |
| Request history / activity | History view with redacted entries, reopen as unsaved request | ✅ | Configurable size; can be disabled |
| WebSocket, gRPC, SSE | — | ❌ | Not implemented |

### Organisation

| Thunder Client capability | REQVYN | Status | Notes / differences |
| --- | --- | --- | --- |
| Collections and folders | Nested folders, drag & drop, ordering, duplicate, rename | ✅ | |
| Collection/folder settings (auth, headers, scripts, variables) | Inherited settings at collection and folder level | ✅ | |
| Favorites / pinned requests | Favorites view | ✅ | |
| Search and filter | Tree filter and quick open (`Ctrl+Alt+R`) | ✅ | |
| Save to workspace (Git sync) | `.reqvyn/` workspace storage, one file per request | ✅ | Diff-friendly, stable key order |
| Team sync (cloud) | Local folder and Git sync providers, Provider SDK | 🟡 | Intentionally no hosted cloud; teams share through Git or a shared folder |

### Variables and environments

| Thunder Client capability | REQVYN | Status | Notes / differences |
| --- | --- | --- | --- |
| Global, collection and environment variables | Global, collection, environment and runtime scopes with documented precedence | ✅ | See [docs/environments.md](docs/environments.md) |
| `.env` files | — | ❌ | Process environment variables (`{{$env:NAME}}`) are supported; the CLI supports `--env-file` |
| System / dynamic variables | `{{$guid}}`, `{{$timestamp}}`, random values and more | ✅ | |
| Secret variables | Secret rows stored in SecretStorage | ✅ | Never written to files or exports |
| Collection-level secret variables | — | 🟡 | Collection variables marked secret are not backed by the vault yet; use environment secrets or `{{$secret:…}}` |

### Authentication

| Thunder Client capability | REQVYN | Status | Notes / differences |
| --- | --- | --- | --- |
| Basic, Bearer, API key | ✅ | ✅ | |
| OAuth 2.0 (auth code, PKCE, client credentials, password) | Plus device code; tokens cached in SecretStorage; refresh tokens | ✅ | The browser callback uses a loopback server |
| AWS Signature v4 | ✅ | ✅ | Tested against reference signatures |
| NTLM | — | ❌ | Not implemented |
| Digest | ✅ | ✅ | |
| Client certificates | PEM/PFX for each request, collection or folder | ✅ | |
| JWT | HS/RS/ES signing | ✅ | |

### Testing and scripting

| Thunder Client capability | REQVYN | Status | Notes / differences |
| --- | --- | --- | --- |
| Scriptless tests | Assertion builder with AND/OR groups | ✅ | |
| Set environment variables from response (chaining) | Extractions (JSON path, header, cookie, regex, status, body) into a chosen scope | ✅ | |
| Pre-request and post-request scripts | Sandboxed scripts with time and memory limits | 🟡 | Own documented API; scripts from other tools are not converted automatically |
| Collection runner | Iterations, data files (CSV/JSON), delay, concurrency, stop on failure | ✅ | |
| Run reports | JSON, HTML, JUnit XML | ✅ | |
| CLI for CI/CD | `reqvyn run/validate/import/export/list` | ✅ | Secrets through `REQVYN_SECRET_*` |

### Import and export

| Thunder Client capability | REQVYN | Status | Notes / differences |
| --- | --- | --- | --- |
| Import Postman | Collections v2.0/v2.1, environments, globals | 🟡 | Saved example responses are skipped with a warning |
| Import Insomnia | v4 exports | ✅ | |
| Import OpenAPI | OpenAPI 3.0/3.1, JSON/YAML; refresh from the spec | 🟡 | Swagger 2.0 and external `$ref` are not supported; refresh needs a local file |
| Import cURL | From a file or the clipboard | ✅ | |
| Import Thunder Client | Collections and environments | ✅ | |
| Import Bruno, Hoppscotch | ✅ | ✅ | Not offered by Thunder Client |
| Export | REQVYN JSON, Postman v2.1, OpenAPI 3, cURL script, `.reqvyn` package | ✅ | Secret values are never exported |

### Platform

| Thunder Client capability | REQVYN | Status | Notes / differences |
| --- | --- | --- | --- |
| Proxy | HTTP(S) proxy, `noProxy`, falls back to `http.proxy` | ✅ | SOCKS is not supported |
| SSL/TLS settings | TLS verification is on by default; custom CAs | ✅ | When disabled, a warning is always logged; disabling is not possible from untrusted workspace settings |
| AI / MCP integration | Optional MCP server in the CLI | 🟡 | Off by default; write and network access need explicit flags; no credential exposure |
| Accessibility | Keyboard navigation, ARIA labels, theme colours, reduced motion | 🟡 | Not yet audited with screen readers across platforms |
| Undo/redo | CodeMirror history; undo for deleted table rows | 🟡 | No global undo across requests |

## Next steps

1. End-to-end tests in a real Extension Development Host (`@vscode/test-electron`), and running the activation smoke test in CI.
2. WebSocket and SSE support, plus GraphQL schema introspection.
3. Vault-backed collection secret variables, and secret header and param rows.
4. Swagger 2.0 and external `$ref` resolution; OpenAPI refresh from a URL, behind an explicit trust prompt.
5. Signed `.reqvyn` packages and ZIP64.
6. NTLM authentication and a cookie editor.
7. A screen reader audit and localisation (`vscode.l10n`).
