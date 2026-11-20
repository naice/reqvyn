# Contributing to REQVYN

Thanks for your interest in improving REQVYN! This guide explains how to set up the project and what we expect from a pull request.

## Ground rules

- **Local-first stays local-first.** Pull requests must not add telemetry, accounts, hosted services or network calls the user did not explicitly start.
- **No fake features.** Every button and command must work. If a feature is incomplete, don't expose it, or document the limitation.
- **Secrets never reach files, logs, exports, history or error messages.** Use the `SecretVault` and the redaction helpers in `@reqvyn/shared`.
- **Engines stay independent of VS Code.** Only `apps/vscode-extension` may import `vscode`. Shared logic belongs in a package so the CLI can use it too.
- **The webview only presents.** New UI features add typed messages to the protocol in `@reqvyn/core` (`protocol.ts`). The extension host does the work.
- Don't copy code, assets or wording from proprietary tools.

## Setup

Requirements: Node.js 20 or newer, pnpm 9 or newer, and Git (for the git sync provider tests).

```bash
pnpm install
pnpm build        # UI bundle, CLI and extension
pnpm typecheck
pnpm lint
pnpm test
```

See [docs/development.md](docs/development.md) for debugging the extension (F5), packaging and publishing.

## Making a change

1. Open an issue first for larger changes, so the design can be discussed.
2. Create a branch, then make your change with tests:
   - Engine code goes in `packages/<name>/test`.
   - Cross-package behaviour goes in `tests/`.
   - Extension helpers go in `apps/vscode-extension/test/unit`, which uses the `vscode` mock.
3. Keep the build green: `pnpm typecheck && pnpm lint && pnpm test`.
4. Update the documentation in `docs/`, and `CHANGELOG.md` under *Unreleased*.
5. Open a pull request that explains what changed and how you tested it.

## Code style

- TypeScript `strict`; avoid `any`. Validate untrusted input with Zod schemas from `@reqvyn/core`.
- Formatting is handled by Prettier (`pnpm format`). Linting uses ESLint (`pnpm lint`).
- Raise errors as `ReqvynError` with a code and an actionable message, and add a `hint` where it helps.
- Keep stored files stable: stable key order and no volatile fields, so Git diffs stay readable.
- UI: use VS Code theme variables, make everything reachable by keyboard, and add ARIA labels to icon-only buttons.

## Adding an importer

1. Add `packages/import-export/src/importers/<format>.ts` that returns `ImportResult` with warnings for anything that was skipped.
2. Register detection in `detect.ts`.
3. Add fixtures and tests in `packages/import-export/test`, including malformed input.
4. Secrets found in the source must go into the result's secret list, never into the collection files.

## Adding a sync provider

See [docs/provider-sdk.md](docs/provider-sdk.md) and the example in `examples/custom-sync-provider`.

## Reporting security issues

Please don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
