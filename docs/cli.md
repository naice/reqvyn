# CLI

The REQVYN CLI runs collections headlessly, for example in CI/CD pipelines. It uses **the same
engines** as the VS Code extension: the same collection store, variable resolution, auth, HTTP
transport, assertions, script sandbox and runner. A collection behaves the same in the editor and
in CI.

## Installation

The CLI is not published to npm yet. Build it from this repository:

```sh
pnpm install
pnpm --filter @reqvyn/cli build        # → packages/cli/dist/reqvyn.cjs (single bundled file, Node ≥ 20)
node packages/cli/dist/reqvyn.cjs help
```

`dist/reqvyn.cjs` has no runtime dependencies. You can copy it into a CI image and run it with
`node reqvyn.cjs …`. The examples below write `reqvyn` for brevity.

## Workspace discovery

Commands work on a **workspace**: a folder that contains `.reqvyn/` (see
[storage-format.md](storage-format.md)).

- **Default:** the nearest folder, starting at the current directory and walking upwards, that
  contains `.reqvyn`.
- **No `.reqvyn` found:** the current directory is used.
- **Override:** `--workspace <dir>` / `-w <dir>`. The folder must exist.

Commit `.reqvyn/` to your repository, and CI sees the same collections as your editor.

## Commands

```text
reqvyn run [collection|folder|request] <name|id> [options]
reqvyn validate [options]
reqvyn import <file...> [options]
reqvyn export <collection> [options]
reqvyn list [options]
reqvyn mcp --enable [--allow-write] [--allow-network]
reqvyn help [command]        reqvyn <command> --help        reqvyn --version
```

You can name collections, folders, requests and environments by **id** or by **name**. Names are
matched case-insensitively.

### `run`

Runs a collection, a folder or a single request.

```sh
reqvyn run "Petstore" --env staging
reqvyn run folder "Orders" --collection "Petstore" --env staging
reqvyn run request "Create order" --collection "Petstore"
reqvyn run "Petstore" --data users.csv --report junit,html --out reports
```

Without a kind (`collection`, `folder` or `request`), the target is treated as a collection. If a
folder or request name exists in several collections, add `--collection`.

| Option | Description |
| --- | --- |
| `-c, --collection <name\|id>` | Collection for `run folder` / `run request` |
| `-e, --env <name\|id>` | Environment to use |
| `-d, --data <file>` | CSV, TSV or JSON data file. Each row is one iteration, and its columns become variables. |
| `-n, --iterations <n>` | Number of iterations (ignored with `--data`) |
| `--delay <ms>` | Delay between requests |
| `--concurrency <n>` | Requests in parallel per iteration (default 1) |
| `--bail` | Stop at the first failed or errored request |
| `--skip <name\|id>` | Skip requests (repeatable or comma-separated) |
| `--var key=value` | Override a runtime variable (repeatable) |
| `--env-file <file>` | Load a `.env` file. Its values are available as `{{$env:NAME}}` and as `REQVYN_SECRET_*`. Real environment variables take precedence over the file. |
| `--secrets <file>` | JSON object of secret name → value. Prefer `REQVYN_SECRET_*` variables. |
| `-r, --report <cli\|json\|html\|junit>` | Reporters (default `cli`; comma-separated or repeated) |
| `-o, --out <dir>` | Report folder (default `./reqvyn-reports`) |
| `--timeout <ms>` | Default request timeout |
| `--proxy <url>` | HTTP(S) proxy for all requests |
| `--ca <file>` | Additional trusted CA certificate (PEM, repeatable) |
| `--insecure` | Disable TLS certificate verification. Prints a warning on every run; for local development only. |
| `--no-scripts` | Do not execute pre-request or post-response scripts |
| `-v, --verbose` | Print script console output and variable changes |
| `-s, --silent` | Print only the summary |
| `-w, --workspace <dir>` | Workspace folder |

What a run does:

- **Scripts** run in the same isolated worker sandbox as in the extension.
- **OAuth 2.0 tokens** obtained during a run are kept in memory only.
- **Ctrl+C** cancels the run and exits with code 130.

#### Reports

The `cli` reporter prints one line per request and a summary of requests, assertions and duration.
File reporters write to the `--out` folder:

| Reporter | File | Contents |
| --- | --- | --- |
| `json` | `reqvyn-report.json` | Full machine-readable run report |
| `html` | `reqvyn-report.html` | Self-contained HTML report |
| `junit` | `reqvyn-junit.xml` | JUnit XML for CI test dashboards (GitHub Actions, GitLab, Jenkins, Azure DevOps) |

Known secret values are redacted from script console output, test names and messages, variable
changes and URLs in the report.

### Secrets in CI: `REQVYN_SECRET_<NAME>`

The CLI never reads VS Code's SecretStorage. Secret values come from environment variables, and
optionally from a `--secrets` JSON file. Names are converted to upper case, and every
non-alphanumeric character becomes `_`. For example, `my-api.Token` becomes `MY_API_TOKEN`.

| Secret | Environment variables tried (in order) |
| --- | --- |
| Environment secret `token` in environment `Staging` | `REQVYN_SECRET_STAGING_TOKEN`, then `REQVYN_SECRET_TOKEN` |
| Global secret `token` | `REQVYN_SECRET_TOKEN` |
| Named secret `{{$secret:apiKey}}` | `REQVYN_SECRET_APIKEY` |

The secrets file can use the same short names (`"STAGING_TOKEN"`, `"token"`) or full vault keys.
Nothing is written to disk.

The CLI also has access to the process environment, read with `{{$env:NAME}}`.

```yaml
# GitHub Actions
- run: node reqvyn.cjs run "Petstore" --env staging --report junit --out reports
  env:
    REQVYN_SECRET_STAGING_TOKEN: ${{ secrets.STAGING_TOKEN }}
```

### `validate`

Checks the workspace without sending any requests:

- files that fail to parse
- requests without a URL
- syntax errors in pre-request and post-response scripts
- body files that do not exist
- folder references that point nowhere
- variables that are not defined in any scope

```sh
reqvyn validate            # errors → exit 1
reqvyn validate --strict   # warnings are errors too
reqvyn validate --json     # findings as JSON
```

### `import`

```sh
reqvyn import postman_collection.json openapi.yaml --dry-run
reqvyn import thunder-collection.json --overwrite
```

`import` accepts these formats:

- Postman v2.0/v2.1 collections and environments
- Insomnia exports
- Thunder Client collections and environments
- Bruno
- Hoppscotch
- OpenAPI 3.x (JSON or YAML)
- cURL commands
- REQVYN exports and `.reqvyn` packages

The format is detected from the content.

| Option | Description |
| --- | --- |
| `--dry-run` | Show what would be imported without writing anything |
| `--overwrite` | Replace collections and environments that already exist with the same id. Without it, they are skipped. |
| `-w, --workspace <dir>` | Target workspace |

Secret values found in imported environments are **not written to disk**. The CLI prints how many
were dropped. Provide them through `REQVYN_SECRET_*` or store them in VS Code.

### `export`

```sh
reqvyn export "Petstore" --format postman --out petstore.postman.json
reqvyn export "Petstore" --format package --env staging --out petstore.reqvyn
reqvyn export "Petstore" --format curl > petstore.sh
```

| Option | Description |
| --- | --- |
| `-f, --format <reqvyn\|package\|postman\|openapi\|curl>` | Default `reqvyn` (native JSON). `package` is the binary `.reqvyn` share format and needs `--out`. `openapi` writes OpenAPI 3 JSON. `curl` writes a shell script. |
| `-o, --out <file>` | Output file (default: stdout) |
| `-e, --env <name\|id>` | Include environments (formats `reqvyn` and `package`) |

Exports never contain secret values. Values that were removed, and features the target format
cannot express, are reported as warnings on stderr.

### `list`

```sh
reqvyn list          # collections (request/folder counts, ids) and environments
reqvyn list --json
```

### `mcp`

Starts the optional, **disabled-by-default** MCP server on stdio. See [mcp.md](mcp.md).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success: all requests ran and all assertions passed (or the command succeeded) |
| `1` | Failed tests or errored requests; validation errors; nothing importable found |
| `2` | Usage or configuration error: unknown option, missing target, not found, I/O or import problems |
| `130` | Cancelled (SIGINT) |

Colour output is enabled only on a TTY. Set `NO_COLOR` or `TERM=dumb` to turn it off.

## Limitations

- The CLI is not yet published as an npm package or a standalone binary.
- `--insecure` disables verification for all hosts. A per-host setting does not exist yet.
- `export --format openapi` writes JSON only. The extension can also write YAML.
- OAuth 2.0 flows that need a browser (authorization code, device code) cannot complete headlessly.
  Use client credentials, or supply a token via a secret.
