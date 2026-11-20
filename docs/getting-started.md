# Getting started

REQVYN is a local-first API client for VS Code. Everything is stored on your machine or in your
repository; there is no account, no cloud service and no telemetry.

## Install

- **From a VSIX:** run `pnpm package` in the repository root (see [development.md](development.md)), then in VS Code run
  *Extensions: Install from VSIX…* and pick `reqvyn.vsix`.
- VS Code **1.90** or newer is required.

After installation the REQVYN icon appears in the activity bar. The sidebar has five views:
**Collections**, **Favorites**, **Environments**, **History** and **Sync**.

## Your first request

1. Press `Ctrl+Alt+N` (`Cmd+Alt+N` on macOS) or run **REQVYN: New Unsaved Request**.
2. Enter a URL, e.g. `https://httpbin.org/get?hello=world`, and pick a method.
3. Press `Ctrl+Enter` (`Cmd+Enter`) or click **Send**.
4. The response pane shows status, time, size, the body (Pretty / Raw / Preview / Tree), headers,
   cookies, the timeline and test results.

An unsaved request lives only in its editor tab. Use **Save** in the request editor to put it into a
collection.

## Collections and where they are stored

REQVYN has two kinds of stores:

| Store | Location | Shared? |
| --- | --- | --- |
| **Personal** | VS Code global storage of the extension (`…/globalStorage/reqvyn.reqvyn/personal`) | No |
| **Workspace** | `<workspace folder>/.reqvyn/` | Yes – commit it to Git |

If the opened folder already contains a `.reqvyn/` directory it is used automatically. To create one,
run **REQVYN: Initialize Workspace Storage (.reqvyn)**. Secret values are never written to either
store; they are kept in VS Code SecretStorage (see [environments.md](environments.md)).

Create a collection with **REQVYN: New Collection**, then add requests and folders from the
collection's context menu (**New Request**, **New Folder**). See [collections.md](collections.md).

## Environments

Create one with **REQVYN: New Environment**, add variables such as `baseUrl`, and activate it with
**REQVYN: Select Environment…** (or click the environment in the status bar). Use variables as
`{{baseUrl}}/users`. Details: [environments.md](environments.md).

## Importing existing work

**REQVYN: Import…** accepts Postman, Insomnia, Thunder Client, Bruno, Hoppscotch, OpenAPI 3, cURL and
REQVYN files. **REQVYN: Import from Clipboard (cURL, JSON, …)** opens a pasted cURL command as a new
request. See [collection-sharing.md](collection-sharing.md).

## Keyboard shortcuts

| Shortcut | Command |
| --- | --- |
| `Ctrl+Enter` / `Cmd+Enter` (in a request editor) | Send Request |
| `Ctrl+Alt+R` / `Cmd+Alt+R` | Quick Open Request… |
| `Ctrl+Alt+N` / `Cmd+Alt+N` | New Unsaved Request |

## Restricted Mode (untrusted workspaces)

In an untrusted workspace REQVYN still sends requests, but:

- pre-request and post-response scripts are **not** run (a warning is shown in the console),
- sync providers are disabled,
- the security-relevant settings `reqvyn.http.verifyTls`, `reqvyn.http.proxy`, `reqvyn.http.noProxy`,
  `reqvyn.http.caCertificates`, `reqvyn.allowProcessEnv` and `reqvyn.scripts.enabled` are only taken
  from your user settings, not from the workspace.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `reqvyn.http.timeoutMs` | `30000` | Request timeout (0 = none) |
| `reqvyn.http.followRedirects` / `maxRedirects` | `true` / `10` | Redirect handling |
| `reqvyn.http.maxResponseMb` | `50` | Maximum response body kept in memory |
| `reqvyn.http.proxy` / `noProxy` | `""` / `[]` | Proxy URL (falls back to `http.proxy`) and bypass list |
| `reqvyn.http.verifyTls` | `true` | TLS verification. Disabling it logs a warning. Prefer `caCertificates`. |
| `reqvyn.http.caCertificates` | `[]` | Extra trusted CA PEM files |
| `reqvyn.http.cookieJar` | `true` | Keep response cookies for the session |
| `reqvyn.scripts.enabled` / `timeoutMs` / `memoryLimitMb` | `true` / `5000` / `64` | Script sandbox |
| `reqvyn.history.enabled` / `maxEntries` | `true` / `200` | Request history |
| `reqvyn.allowProcessEnv` | `true` | Allow `{{$env:NAME}}` |

## Next steps

- [Collections](collections.md) · [Environments & variables](environments.md) · [Authentication](authentication.md)
- [Testing & chaining](testing.md) · [Sharing](collection-sharing.md) · [Storage format](storage-format.md)
