# Sync providers

REQVYN can synchronize collections between installations: your laptop and desktop, or your whole
team. Synchronization is **opt-in, per collection and local-first**:

- **No REQVYN cloud.** No account, no hosted backend, no telemetry. Data goes only where you
  configure a provider to send it.
- **Explicit runs.** Syncing happens when you start it. There is no background or automatic sync.
- **Safe on failure.** Local data stays intact when a provider is offline or fails. Conflicting
  changes are never overwritten silently.
- **Secrets stay local.** Collections are stored with secret values stripped. Those values live in
  VS Code SecretStorage and are never part of a snapshot.

> Sharing a collection once as a file is a different feature: see
> [collection-sharing.md](collection-sharing.md). Committing `.reqvyn/` to your project repository
> is a third option: see [storage-format.md](storage-format.md).

## Built-in providers

| Provider | Id | Remote |
| --- | --- | --- |
| **Local Folder** | `reqvyn.local-folder` | Any directory: local disk, network share (SMB/NFS), USB drive, or a folder synced by a third-party tool |
| **Git** | `reqvyn.git` | A Git repository, through the `git` CLI: a local repository, a bare repository, or one hosted over HTTPS or SSH |

You can build more through the [Provider SDK](provider-sdk.md).

### Local Folder

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `folderPath` | path | – (required) | Absolute path of the shared sync folder |
| `lockTimeoutMs` | number | `10000` | How long to wait while another writer holds the lock |
| `staleLockMs` | number | `30000` | A lock with no heartbeat for this long counts as stale and is broken |

On-disk layout, which the Git provider shares:

```text
<folder>/<collectionId>/
  manifest.json        commit point: revision, updatedAt, entity id → { kind, hash }
  entities/<id>.json   one file per collection-settings / folder / request entity
  tombstones.json      deletion markers (so deletions propagate instead of being resurrected)
  .lock                writer lock (transient)
  .staging/            write journal (transient)
```

Writes are **crash-safe**:

1. All changed files are staged and fsynced.
2. A plan file is written atomically.
3. The files are renamed into place, with `manifest.json` last.

An interrupted write is repaired by the next reader or writer. A journal without a plan is
discarded, so the old state stays intact. A journal with a plan is rolled forward.

Concurrent writers are serialized by a lock file. The lock uses exclusive create and a heartbeat,
so it also works on network shares and removable drives. The revision is a content hash, so
pushes use real compare-and-swap.

### Git

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `repositoryPath` | path | – | Existing working copy. It is initialized if it is not a repository yet. Leave empty to clone `remoteUrl`. |
| `remoteUrl` | string | – | Remote to fetch from and push to: `https://…`, `ssh://…`/`git@…`, or a path to a bare repository. Optional. |
| `cloneDirectory` | path | extension storage | Where to clone when no `repositoryPath` is given |
| `remoteName` | string | `origin` | |
| `branch` | string | `main` | |
| `subdirectory` | string | `reqvyn` | Folder inside the repository that holds the collections |
| `authorName`, `authorEmail` | string | – | Commit identity. If unset, your Git configuration is used. |
| `username` | string | `x-access-token` | User name for HTTPS token auth |
| `token` | **secret** | – | HTTPS access token (see below) |
| `timeoutMs` | number | `120000` | Timeout per git command |

How it behaves:

- **Requirements:** a `git` executable on `PATH`.
- **Non-interactive:** git runs with `GIT_TERMINAL_PROMPT=0` and the credential manager set to
  non-interactive. It never shows a prompt.
- **SSH remotes:** use your SSH agent and keys as usual.
- **The HTTPS token:**
  - It is stored in VS Code SecretStorage.
  - It is passed to git per command as an `http.<origin>.extraHeader` through `GIT_CONFIG_*`
    environment variables.
  - It never appears on the command line or in `.git/config`, and it is redacted from error
    messages.
- **Revisions:** a collection's revision is the SHA of the last commit that touched its directory.
  Pushes of *other* collections therefore do not invalidate it.
- **Each push is one commit:**
  1. The provider fetches and fast-forwards (or rebases) the branch.
  2. It checks the expected revision.
  3. It commits only that collection's directory and pushes.
- **Rejected pushes:**
  - If the collection itself changed remotely, the result is a **conflict**: REQVYN re-pulls and
    merges.
  - If only other paths changed, the push is retried (up to 3 times).
- **Failed pushes:** if a push fails, the local commit is undone, so the working copy never holds
  unpushed sync commits.
- **No remote:** without `remoteUrl`, the repository is purely local and gives you history only.
- **Diverged branches:** if the local branch cannot be rebased automatically, the run fails with a
  `CONFLICT` error and nothing is changed.

## Using sync in VS Code

Everything happens in the **Sync** view of the REQVYN sidebar. Sync is **disabled in untrusted
workspaces**.

1. **Sync → Add Sync Provider**:
   - Pick a provider type and give it a name.
   - Fill in its settings. Secret fields go to SecretStorage, never to `settings.json`.
   - You can configure the same type several times, for example "Git: team" and "Git: personal".
2. **Assign Collection…**: choose a collection, either in the Sync view or in the Collections
   context menu. Only assigned collections are sent to a provider.
3. **Sync Now** runs on an instance (all of its collections) or on one assignment. **Sync All**
   in the view title syncs every instance. The run mode:

   | Mode | What it does |
   | --- | --- |
   | **Sync Now** (bidirectional) | Pull, three-way merge, apply locally, push |
   | **Pull** | Remote → local only |
   | **Push** | Local → remote. Refused with status `remote-ahead` if the remote has changes you have not pulled. |

4. **Pull Remote Collection…** imports a collection that so far exists only remotely, for example
   one a teammate pushed. It needs a provider that can list remote collections, which both
   built-ins can.
5. **Edit Sync Provider…** changes the settings. **Remove Sync Provider** removes the local
   configuration and its secrets. Neither touches the remote, and local collections are kept.

Runs show progress and can be cancelled. When a run finishes you get a summary: added, updated and
deleted entities, locally and remotely. Errors are reported with their cause. Retryable failures
(network, unavailable, rate limit) are retried automatically with backoff, three times by default.

### Conflicts and merging

REQVYN keeps the last synced state (the *base*) for each instance and collection. It merges at the
level of individual collection settings, folders and requests, all identified by stable ids.

| Situation | Result |
| --- | --- |
| Changed on one side only | That change is taken, including deletions |
| Changed on both sides, but in different top-level fields (for example you edited the URL and a teammate edited the tests) | Merged automatically |
| Changed on both sides in the same field, or created concurrently | `edit-edit` conflict |
| Deleted on one side, modified on the other | `delete-edit` / `edit-delete` conflict |

Unresolved conflicts **keep your local version** until you decide. The rest of the run still
completes. The assignment is then marked with a warning icon, and **Resolve Conflicts…** walks
through each conflict:

- For each one, you choose **Keep local** or **Use remote**.
- You can open a side-by-side diff (remote ↔ local) first.
- The next sync applies your decisions.
- If a conflict has changed in the meantime, its decision is ignored and you are asked again.

### Where state is stored

| Data | Location |
| --- | --- |
| Instance configuration (non-secret) | VS Code global state (`reqvyn.sync.instances`) |
| Instance secrets | VS Code SecretStorage, scoped per instance (`sync.<instanceId>.<key>`) |
| Sync state (base snapshot, pending conflicts, last status) | `<globalStorage>/sync-state/` |
| Provider working copies (for example a Git clone) | `<globalStorage>/sync/<instanceId>/` |

## Limitations

- Sync is manual. There is no scheduled or file-watcher sync.
- Environments, globals and history are **not** synchronized. Only collections are.
- Conflict resolution is per entity: keep local or use remote. There is no in-editor field merge.
  Non-overlapping field changes are merged automatically, though.
- Values that are secret in the request itself are never synced, because they are stripped.
  Secret-flagged header or parameter rows arrive empty on the other installation and must be
  filled there. Auth credentials and environment secrets reference the local vault.
- The Git provider needs the `git` CLI and does not open interactive credential prompts. Use SSH
  keys, a credential helper that works without prompting, or the token setting.
- Sync is unavailable in untrusted workspaces and in virtual workspaces.
