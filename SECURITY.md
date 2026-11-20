# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through the repository's **security advisory** feature ("Report a vulnerability"). Don't open a public issue. Include the steps to reproduce, the affected version and the impact. We aim to acknowledge reports within 7 days.

## Security model

REQVYN is a local tool. It doesn't operate servers and sends no data anywhere except:

- the requests you send,
- OAuth 2.0 token endpoints of the auth configs you use,
- the sync providers you configure (a local folder or Git remote).

### Secrets

- Passwords, tokens, secret environment variables, provider credentials and OAuth tokens are stored in **VS Code SecretStorage**, which uses the OS keychain. All keys are prefixed with `reqvyn:`.
- Collection and environment files contain only `{{$secret:name}}` references or empty values for secret rows. Importing a collection with inline credentials moves them into the vault.
- Exports and `.reqvyn` packages never contain secret values. Code generation uses placeholders.
- History entries, logs, run reports and error messages redact sensitive headers (Authorization, Cookie, API keys and similar) and URL credentials.
- The CLI reads secrets only from `REQVYN_SECRET_<NAME>` environment variables.
- The Git provider passes its token to Git as an HTTP `extraHeader` through `GIT_CONFIG_*` environment variables, scoped to the remote's origin. The token never appears on the command line or in `.git/config`, and it is stripped from Git output and errors.

### Workspace trust

In **untrusted workspaces**:

- Pre-request and test scripts don't run.
- Sync providers are disabled.
- Security-relevant settings (`reqvyn.http.verifyTls`, `proxy`, `noProxy`, `caCertificates`, `reqvyn.allowProcessEnv`, `reqvyn.scripts.enabled`) are read from user settings only. A cloned repository can't weaken them.

### TLS

TLS certificate verification is enabled by default. If you disable it, REQVYN logs a warning for every affected request. It is never disabled silently. For self-signed or corporate CAs, use `reqvyn.http.caCertificates` instead.

### Scripts

Scripts run in a separate worker thread with a memory limit and a timeout. Each script gets a fresh `vm` context in which `eval`/`new Function` and WebAssembly are disabled, and `require` and dangerous `process` members are removed. Scripts can't access the file system or the network.

**Limitation:** Node's `vm` isolation is defense in depth, not a hard security boundary. Only run scripts from collections you trust. Because scripts never run in untrusted workspaces, opening an unknown repository doesn't execute its scripts.

### Imports and packages

- Every imported file is validated with schemas, and malformed input is rejected with a message.
- The ZIP reader for `.reqvyn` packages rejects absolute paths, `..` traversal, control characters, duplicate entries, oversized entries and archives (zip bombs), and encrypted or unsupported entries.
- Package integrity is checked with a SHA-256 content hash. Packages are **not signed**, so only open packages from people you trust.

### Webviews

Webviews use a CSP with `default-src 'none'`, nonce-protected scripts, `connect-src 'none'` and no remote resources. HTML response previews render in a sandboxed frame without script or network access. Every message from a webview is validated before it is handled.

### MCP server

The optional MCP server (`reqvyn mcp`) is **off by default** and must be started with `--enable`. It is read-only unless you pass `--allow-write`. Sending requests requires `--allow-network`, optionally restricted with `--allow-host`. It never returns secret values, and scripts are disabled for its runs.

## Supported versions

Security fixes are released for the latest minor version.
