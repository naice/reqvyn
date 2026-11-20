# Environments and variables

## Syntax

| Syntax | Meaning |
| --- | --- |
| `{{name}}` | Variable lookup through all scopes (see precedence below) |
| `{{$secret:name}}` | Value from the secret vault (VS Code SecretStorage). In the CLI: env var `REQVYN_SECRET_<NAME>` |
| `{{$env:NAME}}` | Process environment variable. Only if `reqvyn.allowProcessEnv` is on (default) |
| `{{$uuid}}`, `{{$timestamp}}`, … | Dynamic values, generated per request (list below) |

Variables work in the URL, params, headers, body, auth fields, cookies and assertion expected values.
References may be nested (`{{url_{{stage}}}}`, up to 20 levels). Cycles are reported as an error.
An unresolved variable stays as literal text, e.g. `{{missing}}`, so you can spot it in the sent request.

## Precedence

From lowest to highest; a later scope wins:

1. **Global** – **REQVYN: Edit Global Variables**
2. **Workspace** – `variables` in `.reqvyn/config.json`
3. **Collection** – collection settings, *Variables* tab
4. **Folder** – each folder from outer to inner
5. **Environment** – the active environment
6. **Data** – the current row of a runner data file
7. **Request** – the request's own variables
8. **Runtime** – values set by scripts or extractions during the session

Example: `baseUrl` is `https://api.example.com` in the collection and `http://localhost:3000` in the
active environment "Local" → requests go to `localhost:3000`.

## Managing environments

Environments belong to a store (Personal or Workspace) and appear in the **Environments** view.

| Command | Purpose |
| --- | --- |
| **New Environment** | Create an environment |
| **Edit Environment** | Open the variable table |
| **Duplicate Environment** / **Delete Environment** | As named |
| **Select Environment…** | Pick the active environment (also via the status bar item) |
| **Toggle Active Environment** | Activate/deactivate from the Environments view |
| **Edit Global Variables** | Globals for all workspaces |
| **Clear Runtime Variables and Cookies** | Drop runtime values and the session cookie jar |

The active environment is remembered per store and per workspace. The status bar shows the active
environment of the default store.

## Secrets

Mark a variable row as **secret** (lock toggle) to keep its value out of files:

- Environment secrets are stored in SecretStorage under `env.<environmentId>.<key>`; global secrets
  under `global.<key>`. The JSON file only keeps the key with an empty value.
- Secret values are masked in hover previews, the console, test messages, history and exports.
- Sensitive auth fields (passwords, tokens, client secrets, …) are moved to the vault automatically on
  save and replaced by `{{$secret:auth.<id>.<field>}}`. See [authentication.md](authentication.md).
- Teammates who clone the repository get the keys but have to enter their own secret values.

## Dynamic variables

| Variable | Example result |
| --- | --- |
| `$uuid` (`$guid`, `$randomUUID`) | `0b6c…-4e1f-…` (UUID v4) |
| `$timestamp` / `$timestampMs` | Unix seconds / milliseconds |
| `$isoTimestamp` / `$date` | `2026-11-20T10:00:00.000Z` / `2026-11-20` |
| `$randomInt` / `$randomInt:10:20` | 0–1000 / 10–20 |
| `$randomFloat`, `$randomBoolean` | `0.4271`, `true` |
| `$randomString` / `$randomString:8` | 16 / 8 random characters (max 1024) |
| `$randomEmail` | `…@example.com` |
| `$randomFirstName`, `$randomLastName` | Random names |

## Setting variables from scripts and extractions

```js
reqvyn.env.set('token', reqvyn.response.json().access_token);   // active environment (persisted)
reqvyn.variables.set('orderId', '42');                          // runtime (session only)
reqvyn.collectionVariables.set('lastRun', Date.now());          // collection (persisted)
reqvyn.globals.set('region', 'eu');                             // global (persisted)
```

Writes to environment, collection and global scopes are saved. If the target row is marked secret,
environment and global values go to the vault. Extractions offer the same target scopes; see
[testing.md](testing.md).

## Limitations

- Secret rows in **collection** variables and in the workspace `config.json` are not backed by the
  vault: their value is blanked on save and they resolve to an empty value. Use environment or global
  secrets, or `{{$secret:name}}`, instead.
- A script writing to a secret collection variable is not persisted.
- `{{$env:NAME}}` reads the environment of the VS Code process, not a terminal's environment.
