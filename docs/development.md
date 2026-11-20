# Development

This guide covers building, testing, debugging and packaging REQVYN from source.

## Prerequisites

- **Node.js 20 or newer**: `engines.node` is `>=20`.
- **pnpm 10**: the repository pins `pnpm@10.12.1` via `packageManager`. The easiest way to get it is
  `corepack enable`.
- **VS Code**, to debug the extension.
- **`git` on `PATH`**: needed only for the Git sync provider and its tests.

## Setup

```sh
pnpm install
```

## Common tasks

| Command | What it does |
| --- | --- |
| `pnpm build` | Builds the webview UI (`packages/ui`, Vite), the CLI (`packages/cli`, esbuild), then the extension (`apps/vscode-extension`) |
| `pnpm typecheck` | `tsc` for the root project and for `packages/ui` |
| `pnpm lint` | ESLint 9 over the repository |
| `pnpm format` / `pnpm format:check` | Prettier |
| `pnpm test` | Vitest, single run |
| `pnpm test:watch` | Vitest, watch mode |
| `pnpm package` | Build, then package the extension as `reqvyn.vsix` in the repository root |
| `pnpm audit:deps` | `pnpm audit --prod` |

Builds for a single package:

```sh
pnpm --filter @reqvyn/ui build        # webview → packages/ui/dist
pnpm --filter @reqvyn/ui dev          # webview rebuild on change (vite build --watch)
pnpm --filter @reqvyn/cli build       # → packages/cli/dist/reqvyn.cjs
pnpm --filter reqvyn build            # extension → apps/vscode-extension/dist
```

How the extension build works (`apps/vscode-extension/build.mjs`):

1. It copies `packages/ui/dist` to `dist/webview`, so **build the UI first**.
2. It bundles `src/extension.ts` into `dist/extension.cjs`.

Run `node build.mjs --watch` inside `apps/vscode-extension` to rebundle on change.

### Tests

Vitest runs in the `forks` pool with a 20 s timeout. It picks up these files:

- `packages/**/test/**/*.test.ts(x)`
- `apps/**/test/unit/**/*.test.ts`
- `examples/**/test/**`
- `tests/**`: cross-package fixtures, helpers and sync tests

```sh
pnpm test                                   # everything
pnpm vitest run packages/http-engine        # one package
pnpm vitest run -t "merges non-overlapping" # by test name
```

## Debugging the extension (F5)

The repository includes `.vscode/launch.json` and `.vscode/tasks.json`:

- **Run Extension**: starts an Extension Development Host with `apps/vscode-extension` loaded and all other extensions disabled (`--disable-extensions`). This avoids other extensions interfering with the activity bar.
- **Run Extension (with all installed extensions)**: the same, with your installed extensions enabled.

Both run the default build task, **reqvyn: build extension**, first. It builds the webview and then
bundles the extension. Breakpoints in the extension's TypeScript sources work through source maps.

To debug the webview, run **Developer: Open Webview Developer Tools** in the Extension Development
Host.

For a faster loop:

1. Run `pnpm --filter @reqvyn/ui dev` and `node build.mjs --watch` (in `apps/vscode-extension`) in
   two terminals.
2. Reload the development host with **Developer: Reload Window** after each change.

## Packaging

```sh
pnpm package        # → ./reqvyn.vsix
code --install-extension reqvyn.vsix
```

Packaging runs `vsce package --no-dependencies`. Everything is bundled, so `node_modules` is not
shipped.

## Publishing

Publishing is not automated. You need **your own publisher account**. The `publisher` field in
`apps/vscode-extension/package.json` must match a publisher you control, so change it before you
publish.

```sh
cd apps/vscode-extension
npx @vscode/vsce login <publisher>                 # Visual Studio Marketplace (Azure DevOps PAT)
npx @vscode/vsce publish --no-dependencies

npx ovsx publish ../../reqvyn.vsix -p <token>      # Open VSX
```

Before publishing:

- **Version:** bump `version` in `apps/vscode-extension/package.json`.

## Repository layout

```text
apps/
  vscode-extension/     VS Code extension (activation, tree views, webview host, commands, SecretStorage)
packages/
  shared/               shared types, ids, errors, utilities
  core/                 domain model and schemas
  collection-engine/    collection store on disk (.reqvyn/)
  environment-engine/   environments, globals, variable resolution
  auth-engine/          auth schemes (Basic, Bearer, API key, OAuth 2.0, …)
  http-engine/          HTTP transport (proxy, TLS, redirects, timeouts)
  test-engine/          assertions and the script sandbox
  runner/               collection runner and reporters
  import-export/        Postman, Insomnia, Bruno, Hoppscotch, Thunder Client, OpenAPI, cURL, REQVYN
  sync-core/            sync engine (three-way merge, conflicts, state)
  provider-sdk/         public SDK for sync providers
  providers/
    local/              Local Folder provider (`reqvyn.local-folder`)
    filesystem/         shared on-disk layout, journal and lock (used by local and git)
    git/                Git provider
  cli/                  `reqvyn` CLI and MCP server
  ui/                   webview UI (Vite)
examples/
  custom-sync-provider/ example third-party sync provider
tests/                  cross-package tests, fixtures and helpers
assets/                 icon and other static assets
docs/                   documentation
```

## Related documentation

- [cli.md](cli.md): command-line usage
- [mcp.md](mcp.md): MCP server
- [sync-providers.md](sync-providers.md): built-in sync providers
- [provider-sdk.md](provider-sdk.md): writing your own sync provider
