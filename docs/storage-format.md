# Storage format

REQVYN stores data as plain JSON files designed for Git: one file per entity, stable formatting,
no secrets.

## Directory layout

```text
.reqvyn/
├── config.json                          workspace config
├── .gitignore                           ignores .lock, *.reqvyn-tmp, .backup/, local/
├── collections/
│   └── payments-api.3f9a1c2e/
│       ├── collection.json              collection settings (no children)
│       ├── folders/
│       │   └── orders.8b1d0e47.json
│       └── requests/
│           ├── create-order.c51f9a02.json
│           └── get-order.7e22b3d9.json
└── environments/
    ├── local.0a4b5c6d.json
    └── staging.91ffe203.json
```

The personal store uses the same layout under the extension's global storage
(`…/globalStorage/reqvyn.reqvyn/personal`).

**File names** are `<slug>.<id8>`: the slug is the lower-cased, ASCII-folded name (`a-z0-9` joined by
`-`, max 60 characters, `untitled` if empty); `id8` is the first 8 characters of the entity's UUID.
Renaming an item renames its file. The name is only for humans – the identity is the `id` inside.

**Hierarchy is flat:** folders and requests are not nested on disk. Each has a `parentId` (the
collection or a folder id) and a numeric `sortKey`. Moving a request therefore changes one line, not
a file path.

## File format

- UTF-8 JSON, 2-space indentation, trailing newline.
- Every top-level file has `"schemaVersion": 1`.
- Files that did not change are not rewritten.

### Request

```json
{
  "schemaVersion": 1,
  "id": "c51f9a02-6a7d-4c1e-9b0a-2f6e1d3c4b5a",
  "name": "Create order",
  "parentId": "8b1d0e47-…",
  "sortKey": 1000,
  "method": "POST",
  "url": "{{baseUrl}}/orders",
  "params": [],
  "headers": [
    { "id": "…", "key": "Content-Type", "value": "application/json", "enabled": true }
  ],
  "body": { "mode": "json", "text": "{ \"sku\": \"{{sku}}\" }" },
  "auth": { "type": "inherit" },
  "cookies": [],
  "scripts": { "pre": "", "post": "" },
  "tests": { "id": "…", "kind": "group", "enabled": true, "logic": "and", "items": [] },
  "extractions": [],
  "variables": [],
  "settings": {},
  "docs": "",
  "meta": { "createdAt": "2026-11-20T10:00:00.000Z", "updatedAt": "2026-11-20T10:00:00.000Z" }
}
```

Requests imported from OpenAPI additionally carry `meta.openapi` (`operationId`, `path`, `method`,
`hash`) used by **Refresh from OpenAPI…**.

### Folder

`id`, `name`, `parentId`, `sortKey`, `description`, `variables`, `headers`, `auth`, `scripts`,
`tests`, `settings`, `meta`.

### Collection (`collection.json`)

`id`, `name`, `description`, `variables`, `headers`, `auth` (default `none`), `scripts`, `tests`,
`settings`, `runner` (default runner options), `meta.source` (`type`: `openapi`, `postman`,
`insomnia`, `thunder`, `bruno`, `hoppscotch`, `curl` or `reqvyn`; `location`, `importedAt`, `hash`).

### Environment

```json
{
  "schemaVersion": 1,
  "id": "0a4b5c6d-…",
  "name": "Local",
  "variables": [
    { "id": "…", "key": "baseUrl", "value": "http://localhost:3000", "enabled": true },
    { "id": "…", "key": "apiToken", "value": "", "enabled": true, "secret": true }
  ]
}
```

### Key/value rows

Variables, headers, params and cookies share one shape: `id`, `key`, `value`, `enabled`, optional
`description` and `secret`. When `secret` is `true` the value is always written as `""`; the real
value lives in VS Code SecretStorage.

### `config.json`

Workspace-level `variables`, `collectionOrder` (array of collection ids) and optionally
`activeEnvironmentId`.

## Secrets

Secrets are never stored in these files:

| What | Where |
| --- | --- |
| Environment secret variables | SecretStorage `env.<environmentId>.<key>` |
| Global secret variables | SecretStorage `global.<key>` |
| Sensitive auth fields, `{{$secret:name}}` | SecretStorage `named.<name>` (auth fields: `named.auth.<id>.<field>`) |
| OAuth 2.0 tokens | SecretStorage `oauth2.<cacheKey>` |

Global (non-secret) variables are kept in VS Code global state; the active environment per store in
workspace state.

## Safe writes

- **Atomic:** each file is written to a temporary `.<name>.<random>.reqvyn-tmp` file and renamed into
  place. Leftover temp files from a crash are cleaned up on the next start.
- **Locking:** a `.lock` file prevents two VS Code windows from writing the same store at once.
- **Conflict detection:** REQVYN remembers the hash of every file it loaded. If a file was changed on
  disk since then, saving fails with *"… was changed outside REQVYN"* instead of overwriting.
- **Live reload:** external changes (Git checkout, pull, manual edits) are picked up automatically.

## Migrations

When a future version raises `schemaVersion`, files are migrated on load. The original files are
copied to `.reqvyn/.backup/<timestamp>/…` first. `.backup/` is git-ignored.

## Editing by hand

Hand edits are fine as long as the JSON stays valid and `id`s stay unique. Keep `schemaVersion`.
Invalid JSON is reported as an error naming the file (fix it or restore it from Git). A file with a
`schemaVersion` newer than the installed extension supports is refused with a hint to update REQVYN.
