# Collections

A **collection** groups requests and folders. Folders can be nested. Collections, folders and
requests are stored one file each (see [storage-format.md](storage-format.md)), so Git diffs stay
small and merges rarely conflict.

## Working with the tree

| Action | How |
| --- | --- |
| New collection | **REQVYN: New Collection** (view toolbar or the store's inline action) |
| New request / folder | Context menu of a collection or folder: **New Request**, **New Folder** |
| Open a request | Click it, or **REQVYN: Quick Open Request…** (`Ctrl+Alt+R`) |
| Rename / duplicate / delete | Context menu: **Rename…**, **Duplicate**, **Delete** |
| Move / reorder | Drag and drop in the Collections view (also between collections; multi-select works) |
| Filter | **Filter Collections…** in the view toolbar; **Clear Filter** to reset |
| Favorite | Star icon on a request (**Toggle Favorite**); favorites appear in the Favorites view |
| Copy as cURL | Context menu of a request |
| Run | **Run…** on a collection or folder opens the runner (see [testing.md](testing.md)) |

The order of collections is stored in the workspace `config.json` (`collectionOrder`); requests and
folders keep a numeric `sortKey`.

## Request editor

Tabs: **Params**, **Headers**, **Body**, **Auth**, **Cookies**, **Pre-request**, **Tests**,
**Settings**, **Docs** (Markdown).

Body modes: none, JSON, XML, text, `application/x-www-form-urlencoded`, multipart form (text and file
parts), binary file, GraphQL (query + variables).

The editor shows the breadcrumb, the inherited headers and the effective auth (with its source) above
the request. Variable names autocomplete inside `{{ }}` and show their resolved (secret-masked) value on
hover.

Other editor features:

- **Code generation:** cURL, JavaScript (fetch), TypeScript (fetch), Node.js (fetch), Python
  (requests), C# (HttpClient), PowerShell (Invoke-RestMethod). Secrets are emitted as placeholders,
  never as values.
- **Compare responses:** after sending a request twice, compare the last two responses in the VS Code
  diff editor.
- **Undo:** text editors (URL, body, scripts) use the editor's normal undo/redo; deleting a row in a
  key/value table can be undone for a few seconds. There is no request-wide undo history.

## Inheritance

Collections and folders have their own **Variables**, **Headers**, **Auth**, **Scripts**, **Tests**
and **Settings**. Open them with **Settings (Variables, Headers, Auth, Scripts)…** from the context
menu (on a request this opens the settings of its parent folder or collection).

- **Headers:** collection → folders (outer to inner) → request. A header with the same name
  (case-insensitive) at a lower level replaces the inherited one.
- **Auth:** a request or folder with auth type *Inherit* uses the nearest ancestor with a concrete
  auth. A collection's own default is *None*.
- **Settings** (timeout, redirects, TLS verification, URL encoding, decompression, cookie jar, max
  response size): merged collection → folders → request; unset values fall back to the global
  `reqvyn.http.*` settings.
- **Scripts and tests:** all levels run, outermost first (collection, folders, request).

## History

Every sent request is added to the History view (if `reqvyn.history.enabled`), limited to
`reqvyn.history.maxEntries`. History is stored in the extension's global storage as `history.json`
with sensitive values stripped. Click an entry to open it as a new unsaved request. **Clear History**
removes everything.

## OpenAPI-backed collections

A collection imported from an OpenAPI file can be updated with **Refresh from OpenAPI…** (context
menu of the collection). REQVYN shows the planned changes (added, changed, removed operations) and lets
you apply them, optionally removing operations that are no longer in the spec. Requests are matched by
operation (method + path / operationId); your tests, scripts and extractions on existing requests are
kept.

Limitations: the spec must be a local file (no URL fetching); external `$ref`s are not resolved;
Swagger 2.0 is rejected.
