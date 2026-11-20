# Sharing collections

There are three ways to share: commit the workspace store, exchange a file, or use a sync provider
([sync-providers.md](sync-providers.md)).

## 1. Commit `.reqvyn/` to Git (recommended for teams)

Run **REQVYN: Initialize Workspace Storage (.reqvyn)** and create collections in the *Workspace*
store. Each request, folder and environment is a small JSON file (see
[storage-format.md](storage-format.md)), so reviews and merges work like with code. REQVYN reloads
automatically when files change on disk (e.g. after `git pull`).

Secrets never land in these files. Each teammate enters their own secret values once; they are kept
in that person's VS Code SecretStorage.

If you save while a file was changed outside REQVYN, the save is refused with a conflict message
(*"was changed outside REQVYN"*) instead of overwriting the other change. Reload and redo the edit.

## 2. Export and import files

### Export

**Export…** on a collection offers:

| Format | Notes |
| --- | --- |
| REQVYN JSON | Single file with the collection and the chosen environments |
| REQVYN package (`.reqvyn`) | ZIP with one file per item and a manifest with SHA-256 checksums |
| Postman Collection v2.1 | Scripts become Postman events; `reqvyn.*` calls will not run in Postman |
| OpenAPI 3 (JSON / YAML) | Best effort: folders become tags; scripts, tests and auth details beyond simple schemes are lost |
| cURL script (`.sh`) | One `curl` command per request; variables stay as `{{name}}` |

**Share as Package (.reqvyn)…** creates a package and asks which environments to include.

What is removed on export:

- all vault secrets and values of variables marked secret,
- literal values of `Authorization`, `Cookie` and API-key headers,
- sensitive auth fields,
- in environments: values that look sensitive (names such as *token*, *password*, *secret*, *key*).

After export REQVYN reports how many values were blanked and offers **Reveal** to open the file.
Recipients fill in the blanks in their own environment.

Single requests can be shared with **Copy as cURL** or the code generator (secrets become
placeholders).

### Import

**Import…** detects the format from the file content:

| Source | Supported |
| --- | --- |
| REQVYN | collection JSON, environment, request, package (`.reqvyn`/`.zip`) |
| Postman | collection v2.0 / v2.1, environment, globals |
| Insomnia | export v4 (JSON or YAML) |
| Thunder Client | collection, environment |
| OpenAPI | 3.0 / 3.1, JSON or YAML (Swagger 2.0 is rejected) |
| Bruno | `.bru` files, several `.bru` files at once, Bruno JSON export |
| Hoppscotch | collection, environment (`<<var>>` becomes `{{var}}`) |
| cURL | bash/POSIX, Windows `cmd` (`^`) and PowerShell (`` ` ``) syntax; multiple commands per file |

Flow: choose the target store → preview of what will be imported → if a collection with the same
identity exists, choose **Import as a separate copy**, or merge (*keep both*, *overwrite matching
requests*, *skip matching requests*). Inline secrets in imported files (passwords, tokens) are moved
to the vault.

**Import from Clipboard (cURL, JSON, …)** takes the clipboard text. A single request (e.g. a cURL
command copied from browser dev tools) opens as an unsaved request; you are warned if it contains
credentials.

**Import warnings** are shown after import. Common ones:

- Scripts written for Postman/Bruno/Insomnia are imported unchanged. `pm.*` calls work for the
  supported subset (see [testing.md](testing.md)); `bru.*` and `insomnia.*` calls do not.
- Insomnia template tags (`{% … %}`) are kept as text; Insomnia folder scripts are not imported.
- Saved example responses (Postman, Hoppscotch) are not imported.
- cURL `-k` becomes a request with TLS verification off; proxy and CA options are not imported.
- Bruno `.env` files are not imported.

## Package format and integrity

A `.reqvyn` package contains `manifest.json`, `collection/collection.json`,
`collection/folders/<id>.json`, `collection/requests/<id>.json` and `environments/<id>.json`. The
manifest lists each file with its SHA-256 and size, plus an overall `integrity` hash. On import every
checksum is verified and the archive is checked against size limits (5000 entries, 20 MB per entry,
50 MB uncompressed, suspicious compression ratios rejected).

The integrity hash detects corruption and accidental edits. It is **not a signature**: anyone can
modify a package and recompute the hashes. Only import packages from sources you trust, and review
scripts before running them.

## Limitations

- HAR files appear in the import dialog filter but are not supported yet.
- OpenAPI and cURL-script exports do not report how many values they blanked.
- ZIP64 archives are not supported.
