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
  committed state.
- Shutdown stops timers and releases the engine lock. There is no tray/auto-start in this implementation, so syncing
  runs while the MyHarness Web process is running.

## Failure behavior

| Situation | Behavior |
| --- | --- |
| Network down | Local use continues; the failure is shown; retry keeps the pending changes |
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

## HTTP routes

All routes are local-only and use the same origin checks as the rest of the Web UI.

| Route | Purpose |
| --- | --- |
| `GET /api/sync/state` | Status snapshot (account, folder, counters, conflicts, bindings, issues, risk) |
| `POST /api/sync/config` | `{ enabled?, paused?, clientId?, clientSecret?, deviceName? }` |
| `POST /api/sync/connect` | Start OAuth; answers `{ authUrl }`, completion continues in the background |
| `POST /api/sync/disconnect` | Stop syncing and forget the token on this device |
| `POST /api/sync/check` | Run one push + pull pass now |
| `POST /api/sync/bind` | `{ workspaceId, rootPath }` bind a restored workspace folder |

## Limits and not-yet-verified behavior

- Real Google OAuth, two physical machines, folder rename, revoked authorization, quota exhaustion and Drive outage
  behavior have not been run against a live account; only the in-memory Drive tests are executed.
- Background sync stops when MyHarness quits. Tray support and launch-at-login are not implemented.
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

The suite covers: first upload and restore on a second device, memory deletion without resurrection, concurrent memory
conflicts with a recoverable copy, chat branch merge, draft and prompt deletes, concurrent delete-vs-edit, missing
objects deferring a batch, no re-reading of already applied batches, a large change set split into several batches, an
ignored self-batch, refused hostile identities, a damaged batch reported once, an object that never arrives reported
and skipped, archive markers and ordinary JSON files beside artifacts, a Workspace removed from every list, a chat
entry conflict that keeps a recoverable copy even when the merge changes nothing, and a remote timestamp that tries to
steer the write outside the chat folder.
