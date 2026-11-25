# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.4] – 2026-11-25

### Changed

- The find bar in editors (response body, request body, scripts) looks like VS Code's find widget: toggle buttons for match case, whole word and regex, a match counter ("3 of 12"), icon buttons, and a collapsible replace row in editable editors.
- Search matches are highlighted in solid yellow, the current match in orange, as in VS Code's find widget.

### Fixed

- Ctrl+F in an editor no longer also opens VS Code's find widget, which took the focus away from the editor's own find bar.

## [0.1.3] – 2026-11-20

### Added

- Sponsor link to [Ko-fi](https://ko-fi.com/emmuss): shown as a Sponsor button in VS Code's extension view and on the GitHub repository.
- Badges for the Marketplace version, installs, license and GitHub stars in the README.

## [0.1.2] – 2026-11-20

### Changed

- The extension homepage is now the official website, https://aineering.de/reqvyn/. The README links to the website, the Marketplace and the documentation.

## [0.1.1] – 2026-11-20

### Added

- Screenshots in the README and on the Marketplace page.

## [0.1.0] – 2026-11-20

First public preview.

### Added

- **Requests:** REST and GraphQL requests with JSON, XML, text, form-urlencoded, multipart, binary and GraphQL bodies. Includes a CodeMirror editor with variable highlighting and completion, and `Ctrl/Cmd+Enter` to send.
- **Responses:** JSON tree, sandboxed HTML preview, headers, cookies, timings and timeline. Open a response in an editor, or compare two responses in VS Code's diff view.
- **Collections:** folders, drag & drop, duplicate, rename, favorites, filter and quick open. Collection and folder settings (variables, headers, auth, scripts) are inherited by requests.
- **Workspace storage:** `.reqvyn/` with one file per request, atomic writes and reload on external changes. A personal store is used when no workspace is open.
- **Environments:** global, collection, environment and runtime variables, dynamic variables and `{{$env:…}}`. Secret values are kept in SecretStorage. The active environment is shown in the status bar.
- **Authentication:**
  - Basic, Bearer, API key, Digest, JWT, AWS Signature v4 and client certificates.
  - OAuth 2.0 with the authorization code (PKCE), client credentials, device code and password grants, with token caching and refresh.
- **Tests:** a scriptless assertion builder, extractions for request chaining, and sandboxed pre-request and test scripts (trusted workspaces only).
- **Collection runner:** iterations, CSV/JSON data, delay, concurrency and stop-on-failure. Reports export as JSON, HTML or JUnit.
- **Import:** Postman, Insomnia, Thunder Client, Bruno, Hoppscotch, OpenAPI 3, cURL (including from the clipboard) and `.reqvyn` packages. Includes an import preview and a conflict strategy, and OpenAPI-based collections can be refreshed from their spec.
- **Export and sharing:**
  - Export to REQVYN JSON, Postman v2.1, OpenAPI 3 (JSON/YAML) and cURL scripts.
  - Share collections as `.reqvyn` ZIP packages.
- **Code generation:** cURL, fetch (JS/TS/Node), Python, C# and PowerShell.
- **Sync:** the Sync SDK with three-way merge and conflict resolution, plus local folder and Git providers. Third-party providers can register through the extension API.
- **CLI:** the `reqvyn` CLI with `run`, `validate`, `import`, `export` and `list`.
- **MCP server:** an optional MCP server with an explicit trust policy.
- **Network:** proxy and no-proxy, custom CAs, cookie jar, redirect and size limits, and TLS verification enabled by default.

### Known limitations

- WebSocket, gRPC, SSE and NTLM are not supported.
- OpenAPI: Swagger 2.0 and external `$ref` are not supported, and refresh works only from local files.
- Postman saved example responses are not imported.
- Collection-level secret variables, and secret header and param rows, are not backed by the vault yet. Their values are cleared when saved.
- `.reqvyn` packages are hash-verified but not signed. ZIP64 is not supported.
- There are no end-to-end tests in a real VS Code instance yet.
