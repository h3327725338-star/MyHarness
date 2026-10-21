# Google Drive sync

MyHarness can keep memories and General-mode chat data in sync through a folder in the user's own Google Drive. It
talks to the Drive API directly; the Google Drive desktop client is not required for application data, and a workspace
that already lives inside Drive stays managed by the Drive client.

This document describes the implemented behavior. Real two-machine Google verification is still pending: the tests use
an in-memory Drive, and no live Google account is used by the automated checks.

## What is synced

| Data | Synced |
| --- | --- |
| Global, Workspace and Session memories, including archives, pending quarantine and the user profile | Yes |
| General-mode Workspaces: identity, name, instructions, memory/library switches | Yes |
| General-mode chats: conversation JSONL (branches merged by entry id), handoff metadata, session metadata | Yes |
| Session attachments (`uploads/`), artifacts, notes, tool results and other session files | Yes |
| Workspace library sources and workspace artifacts | Yes |
| General-mode drafts and the General personal prompt | Yes |
| Coding-mode chats, repositories, worktrees | No |
| API keys, OAuth tokens, trust decisions, tool permissions, locks, running tasks | No |
| Memory catalogs (`memory/index.json`, `memory/state.json`, `maintenance.*`), bridge descriptors and write locks | No |

Archive and pin markers (`<conversation>.jsonl.archived`, `.pinned`) travel with the chat, so the other device shows
the same archived and pinned state. An empty General prompt or draft is represented as a deletion, so clearing it on one
device clears it on the others; retyping it afterwards is a newer version and is applied again.

## Setup

1. In Google Cloud Console create an OAuth client of type **Desktop app** and enable the Google Drive API.
2. Open **Settings → Google Drive** in MyHarness, paste the client id **and the client secret** and save each one.
3. Press **Connect Google Drive** and complete the sign-in in the system browser.
4. MyHarness creates `My Drive/MyHarness/sync-v1/…` and starts the first upload.

Both values are required. Google's token endpoint answers `client_secret is missing` and refuses the exchange when a
desktop client sends only the authorization code and its PKCE verifier, so the secret is stored next to the client id
and sent with the code exchange and every refresh. It is not a confidential value for an installed app — it cannot
keep a secret that ships with the client — but the endpoint still demands it. `MYHARNESS_GOOGLE_CLIENT_ID` and
`MYHARNESS_GOOGLE_CLIENT_SECRET` remain available as a fallback for a build started from a shell.

Only the `drive.file` scope is requested: MyHarness can manage the files it created and files the user explicitly hands
to the app, not the rest of the drive.

## Cloud layout

```text
My Drive/
└─ MyHarness/
   ├─ README.txt
   └─ sync-v1/
      ├─ identity.json
      ├─ batches/<batchId>.json
      ├─ objects/<sha256>
      └─ snapshots/
```

- `identity.json` contains the sync space id. A renamed folder is still found by its Drive file id; a second folder with
  the same name is not adopted automatically.
- A batch is published only after every object it references has been uploaded. Receivers wait for missing objects and
  verify the SHA-256 before applying anything.
- Deletions are explicit operations with a version vector and timestamp, never inferred from a listing.
- `objects/` is content-addressed, so identical attachments are stored once.
- A large first upload is published as several batches of at most 500 operations, never as one batch a receiver would
  refuse.
- A batch from the same device is marked as seen without being applied: the local state already contains it.
- A damaged batch, a batch over 5000 operations, or a batch whose object never arrives is reported once in Settings and
  then skipped, so one bad file cannot keep the sync loop busy forever. A damaged or oversized batch is also remembered
  by name, so a full issue list cannot make it readable again.

## Merge rules

Each record has a stable key (`kind:id`) and a per-device version vector.

- Remote version dominates the local one: apply it.
- Local version dominates: keep it.
- Concurrent edits of a chat: the JSONL files are merged by entry id, preserving both branches. An entry, or the
  header, that both devices changed differently keeps the local version and saves one copy of the remote file — even
  when the merge itself changed nothing else.
- Concurrent edits of a memory, attachment or workspace: the local version stays in use and the other version is saved
  under `<agentDir>/sync/recovered/…`; the conflict is listed in Settings.
- Delete vs edit: the deletion is not silently undone, but the edited content is kept as a recoverable copy.
- Re-creating a record after the deletion has been seen is a newer version and is applied; an old offline copy that
  predates the deletion is not resurrected.

Nothing in the applied data triggers a model call, memory extraction or command execution. A remote record cannot grant
Project Trust or run tools.

## Workspaces on another machine

A Workspace is identified by its stable `workspaceId`. Its root folder is bound per device:

- an existing local Workspace keeps its own folder;
- a restored Workspace is created under `<dataRoot>/workspace-folders/<name>-<id8>` and marked as waiting for a folder;
- the original absolute path from the other machine is only shown as a hint;
- **Choose folder** in Settings binds the real folder. MyHarness never writes its sync data into an external folder and
  never changes sharing permissions.
- a binding (or a Workspace applied from another device) takes effect without a restart: the running app re-reads the
  Workspace registry, so its own copy can never be saved back over the new folder, and open idle chats of that
  Workspace move onto it, so the Files panel shows the bound folder at once;
- a chat synced from another device stores that device's folder in its header; when that folder does not exist here
  (or the chat still sits in the managed placeholder after the real folder was bound) it opens in its Workspace's folder
  on this device. Other chats, such as a worktree or a sub-folder that exists, keep their own folder.

Coding-mode registrations are not copied when a General workspace is removed; removing a workspace in General leaves the
physical directory in place. A Workspace the user removed from every list keeps its files here, is not published again,
and is published again only after it is added back on that device; removing it on one device removes it from the other
device's General list without deleting chats or memories.

## Local state and credentials

Everything device-specific lives below `<agentDir>/sync/`:

- `config.json` — device name/id, enabled, paused, OAuth client id and secret, cloud folder id, account label;
- `state-<account>.json` — vectors, tombstones, applied batches, conflicts, bindings (one file per Google account);
- `credentials.json` — access/refresh token, written with mode 0600 and atomic replace;
- `backups/`, `recovered/` — previous and unapplied versions, at most 20 per key.

The Google token never enters the Data root, a chat, a tool result or the sync folder. It is protected by file
permissions only. It is **not** encrypted with Windows DPAPI/Electron `safeStorage` and the transfer is **not**
end-to-end encrypted: Google stores the data under the account's normal Drive protection.

## Scheduling

- Local file changes are watched and debounced (~0.8 s), then pushed.
- While the app is connected it checks for remote batches every ~10 s; idle every ~45 s.
- Errors retry after ~30 s; offline changes stay queued because the pending queue is the difference from the last
  committed state. While Drive cannot be reached the queue is still counted from the local files, so "Waiting to
  upload" shows the real number offline, and the next retry after the network returns continues on its own.
- Each pass downloads first and then uploads. A download that fails (network, a batch that cannot be read, a full disk)
  no longer holds this device's own changes back: the upload still runs in the same pass and the download error is
  shown afterwards.
- Resuming after the app was closed, crashed or the computer lost power needs no button: on the next start the engine
  rescans, and everything not yet committed is queued again. Large uploads are published in batches of at most 500
  operations and each batch is committed locally as soon as Drive has it, so the upload continues after the last
  finished batch. Objects are content-addressed and looked up before upload, so content already in Drive is not sent
  again; a file that changed between scan and upload is left for the next pass, so an object never differs from its
  hash.
- Before a batch manifest is written, the batch is journaled in `state-<account>.json` (`publishing`). If the process
  stops after Drive accepted the manifest but before the local commit, the next start finds the manifest and commits it
  instead of publishing the same changes a second time; if the manifest never arrived, the journal is dropped and the
  changes are published again.
- Shutdown stops timers and releases the engine lock. There is no tray/auto-start in this implementation, so syncing
  runs while the MyHarness Web process is running; after a reboot it continues when MyHarness is started again.

## Failure behavior

| Situation | Behavior |
| --- | --- |
| Network down | Local use continues; the failure is shown; retry keeps the pending changes and resumes on its own |
| Disk full, file in use or no permission while applying | The batch stays waiting to download (not marked applied, not an issue); the reason is shown; retried automatically |
| Authorization revoked | One refresh attempt, then an error; local data is untouched; connect again |
| Cloud folder deleted from Drive | Error “folder no longer available”; local data and pending work stay; no silent re-upload |
| `identity.json` missing | Error and a request to reconnect; a new space is not created silently |
| Data root inside a cloud-synced folder | Sync refuses to start and explains the double-management risk |
| Another MyHarness process owns the engine lock | Status shows “another process”; no second writer |
| File larger than 200 MB | Not uploaded; listed under “needs a manual look” until it fits |
| File larger than 256 MB in the scanned tree | Not scanned at all; it stays local only |
| Damaged remote batch or missing object | Reported once in Settings, then skipped; other batches still apply |
| Remote record with an unusable identity | Refused before any path is built; reported once |
| Remote chat timestamp that is not a plain timestamp | Sanitised into the generated file name; it cannot choose a folder |

## Manual buttons

Settings → Google Drive has three buttons in one row:

- **Check now** — one ordinary pass (download, then upload), the same pass the timer runs.
- **Download now** — download only. It waits for a pass that is already running, then keeps listing the batches folder
  until nothing new is left (bounded to 20 rounds), so batches that arrive during a long download are fetched too. It
  also gives batches skipped earlier for a missing object or a failed apply another chance. Nothing is uploaded.
- **Sync now** — the same complete download followed by the upload of everything waiting on this computer.

Download now and Sync now answer at once (409 when sync is paused, Drive is not connected or a manual run is already
going) and report progress through the status: `manual = { kind, state: running|done|failed, stage, done, total,
remainingDownloads?, error? }`. The row shows "Downloading… x / y", "Uploading… x / y", the finish or the failure
reason; both buttons are disabled while one runs. Pause means nothing is uploaded or applied, so while paused both
buttons are disabled and the routes refuse; Check now keeps its old behaviour (a pass that does nothing while paused).

## HTTP routes

All routes are local-only and use the same origin checks as the rest of the Web UI.

| Route | Purpose |
| --- | --- |
| `GET /api/sync/state` | Status snapshot (account, folder, counters, conflicts, bindings, issues, risk) |
| `POST /api/sync/config` | `{ enabled?, paused?, clientId?, clientSecret?, deviceName? }` |
| `POST /api/sync/connect` | Start OAuth; answers `{ authUrl }`, completion continues in the background |
| `POST /api/sync/disconnect` | Stop syncing and forget the token on this device |
| `POST /api/sync/check` | Run one push + pull pass now |
| `POST /api/sync/download` | Start "Download now" in the background; progress in the status's `manual` |
| `POST /api/sync/sync` | Start "Sync now" in the background; progress in the status's `manual` |
| `POST /api/sync/bind` | `{ workspaceId, rootPath }` bind a restored workspace folder |

## Limits and not-yet-verified behavior

- Real Google OAuth, two physical machines, folder rename, revoked authorization, quota exhaustion and Drive outage
  behavior have not been run against a live account; only the in-memory Drive tests are executed.
- Background sync stops when MyHarness quits and continues on the next start. Tray support and launch-at-login are not
  implemented, so after a reboot nothing uploads until MyHarness is opened.
- Batches over 5000 operations written by another client are refused; this daemon never writes such a batch itself.
- Concurrent conflicts are kept for review but there is no “apply the other version” button yet; the copy path is shown.
- The `snapshots/` folder is part of the layout but snapshots are not used yet for faster bootstrap.
- Workspace files that live outside the MyHarness Data root (an external folder, including one in Drive) are not
  copied by this sync; the Drive client keeps managing them.
- A chat whose header becomes unreadable or whose mode is switched to Coding is kept locally instead of being deleted,
  and is not republished until it is written again.
- A symlinked directory inside the Data root is refused as a safety measure, so a user who deliberately links a folder to
  another disk sees an error instead of a silent write. A Windows junction is not reported as a link by the filesystem
  API, so the Data root should stay on a real directory.
- The applied-batch log keeps the last 2000 entries; an ancient batch that is re-listed is normally a no-op, but this is
  not a substitute for the missing snapshot-based bootstrap.

## Tests

```powershell
npm.cmd --workspace packages/coding-agent run test -- test/google-drive-sync.test.ts
```

`test/google-drive-sync-resume.test.ts` covers resuming: a manifest Drive accepted just before the app stopped is
committed without a second batch or upload, a manifest that never arrived is published again with the objects reused,
a large upload resumes after its last published batch, offline changes stay counted and upload once the network is
back, a failing download does not block the upload, a full disk keeps the batch waiting, and the manual Download now /
Sync now runs (draining batches that arrive during the run, retrying a skipped batch, waiting for a running pass,
refusing while paused).

The suite covers: first upload and restore on a second device, memory deletion without resurrection, concurrent memory
conflicts with a recoverable copy, chat branch merge, draft and prompt deletes, concurrent delete-vs-edit, missing
objects deferring a batch, no re-reading of already applied batches, a large change set split into several batches, an
ignored self-batch, refused hostile identities, a damaged batch reported once, an object that never arrives reported
and skipped, archive markers and ordinary JSON files beside artifacts, a Workspace removed from every list, a chat
entry conflict that keeps a recoverable copy even when the merge changes nothing, and a remote timestamp that tries to
steer the write outside the chat folder.
