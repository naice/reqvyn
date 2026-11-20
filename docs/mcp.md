# MCP server

REQVYN includes an optional [Model Context Protocol](https://modelcontextprotocol.io) server. AI
assistants can use it to read collections, create or edit requests, generate collections from an
API description, and run tests. It is part of the CLI (`reqvyn mcp`) and runs locally over stdio.

> **Disabled by default.** The server refuses to start unless it is explicitly enabled. Even when it
> is enabled, every tool that writes files or sends network requests stays disabled until you allow
> it with a flag.

## Starting the server

Build the CLI first (see [cli.md](cli.md#installation)). Then:

```sh
node packages/cli/dist/reqvyn.cjs mcp --enable -w /path/to/project
```

| Option | Description |
| --- | --- |
| `--enable` | Required. Alternatively, set `REQVYN_MCP_ENABLED=1`. Without either, the command prints an error and exits with code 2. |
| `--allow-write` | Allow tools that change the workspace (`create_request`, `update_request`, `generate_collection`) |
| `--allow-network` | Allow `run_tests` to send HTTP requests |
| `--allow-host <host>` | Restrict `run_tests` to these hosts (repeatable). `*.example.com` matches subdomains. Without any `--allow-host`, any host is allowed once `--allow-network` is set. |
| `-w, --workspace <dir>` | Workspace folder (same discovery rules as the CLI) |

Transport details:

- **Framing:** JSON-RPC 2.0, one message per line on stdin/stdout.
- **Logging:** all diagnostics go to stderr.
- **Protocol version:** `2025-06-18`.
- **Methods:** `initialize`, `ping`, `tools/list` and `tools/call`. Notifications are accepted and
  ignored.

### Client configuration

Most MCP clients take a command plus arguments. For example:

```json
{
  "mcpServers": {
    "reqvyn": {
      "command": "node",
      "args": [
        "/absolute/path/to/REQVYN/packages/cli/dist/reqvyn.cjs",
        "mcp",
        "--enable",
        "--allow-network",
        "--allow-host", "localhost",
        "--allow-host", "*.staging.example.com",
        "-w", "/absolute/path/to/your/project"
      ],
      "env": {
        "REQVYN_SECRET_STAGING_TOKEN": "…"
      }
    }
  }
}
```

Add `--allow-write` only if the assistant should be able to modify your collections.

## Tools

| Tool | Needs | Description |
| --- | --- | --- |
| `list_collections` | – | Collections in the workspace (summaries with ids) and environments (id and name) |
| `get_collection` | – | The folder/request tree of one collection |
| `get_request` | – | A single request, **with secret values stripped** |
| `create_request` | `--allow-write` | Create a request in a collection. Fields follow the request schema; set `parentId` to place it in a folder. |
| `update_request` | `--allow-write` | Update fields of an existing request (shallow merge of the given fields) |
| `generate_collection` | `--allow-write` | Import a collection from text: OpenAPI 3.x, Postman, Insomnia, cURL and the other formats the importer supports. Takes an optional collection name. |
| `run_tests` | `--allow-network` | Run a collection, a folder or a list of requests, optionally with an environment. Returns a summary and a `runId`. |
| `get_test_results` | – | Fetch the summary of an earlier run by `runId`. The last 20 runs are kept in memory. |

Tools that policy forbids are still listed. `tools/list` marks them "(currently disabled by
policy)". Calling one returns an `isError` result that names the flag needed to enable it.

Results are returned both as JSON text in `content` and as `structuredContent`.

## What the assistant can and cannot see

- **Secrets:**
  - Secret values are never returned. `get_request` strips them, and run summaries contain only
    names, statuses, durations and assertion results.
  - Run summaries contain no request or response bodies and no headers.
  - The server reads secrets only from `REQVYN_SECRET_*` environment variables (same mapping as the
    [CLI](cli.md#secrets-in-ci-reqvyn_secret_name)). It never reads VS Code SecretStorage.
- **Scripts:** `run_tests` runs **with scripts disabled**. Pre-request and post-response scripts in
  the collection are not executed, but declarative assertions are evaluated.
- **Host allow-list:** with `--allow-host`, the allow-list is checked on every hop after variable
  resolution, before anything is sent. This covers the initial request, every HTTP redirect and
  token requests made by the auth engine (for example OAuth 2.0 client credentials). Requests to
  other hosts fail with an `UNTRUSTED` error in the run.

## Limitations

- **Host allow-list scope:** the check matches host names only (exact host or `*.` suffix). It does
  not resolve DNS, so a permitted name that resolves to an internal address is still reached.
- **Scripts:** collections that depend on scripts, for example to set variables or chain requests,
  can behave differently under `run_tests` than in the extension or the CLI.
- **Swagger 2.0:** not supported by `generate_collection`. Convert the description to OpenAPI 3
  first.
- **Run history:** kept in memory only. It is lost when the server process ends.
- **Transport:** stdio only. There is no HTTP/SSE transport.
