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
| Ordinary files inside a General workspace, after the user turns file sync on | Yes, through the separate file channel below |
| Files inside a Drive-managed workspace | No, the Google Drive client syncs them |
| Coding-mode repository files, worktrees and build output | No |
| General-mode drafts and the General personal prompt | Yes |
| Saved prompts of the Web UI (Session panel → My prompts) | Yes, only that list; other Web UI preferences stay on each device |
| Coding-mode chats, repositories, worktrees | No |
| API keys, OAuth tokens, trust decisions, tool permissions, locks, running tasks | No |
| Memory catalogs (`memory/index.json`, `memory/state.json`, `maintenance.*`), bridge descriptors and write locks | No |

Archive and pin markers (`<conversation>.jsonl.archived`, `.pinned`) travel with the chat, so the other device shows
the same archived and pinned state. An empty General prompt or draft is represented as a deletion, so clearing it on one
device clears it on the others; retyping it afterwards is a newer version and is applied again. The saved prompts work the same way (record
`saved-prompts:web`): an emptied list is a deletion. An arriving list replaces `prefs.savedPrompts` in
`<agentDir>/web-ui-prefs.json` with a newer `updatedAt` and keeps every other preference; open pages read it again on
`sync_applied`. Devices running an older version ignore this record. Both devices changing the list before syncing is
a conflict like any other non-chat record: the local list stays and the other one is kept as a copy.

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
      ├─ snapshots/
      └─ files/<workspace>__<batchId>.json
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

## Local polling cost

Memory scans reuse ancestor safety checks within each traversal and retain only file identity metadata between polls.
Unchanged Markdown is not read or YAML-parsed again; replacement, modification and deletion are checked on the next scan.
A successful poll that changes only `lastCheckAt` writes a small `state-<hash>.json.check.json` sidecar rather than
rewriting the complete protocol state. Protocol changes still commit synchronously and atomically before proceeding;
restart loads the latest check time from either file. Local-only memory catalogs, maintenance files, temporary files
and root-level traces do not trigger an extra watcher-driven scan; periodic reconciliation remains enabled.

## Merge rules

Each record has a stable key (`kind:id`) and a per-device version vector.

- Remote version dominates the local one: apply it.
- Local version dominates: keep it.
- Concurrent edits of a chat: the JSONL files are merged by entry id, preserving both branches. An entry, or the
  header, that both devices changed differently keeps the local version and saves one copy of the remote file — even
  when the merge itself changed nothing else.
- Concurrent edits of a memory of any scope (global, workspace, session, archived, pending, profile): the two versions
  are merged line by line against the last version both devices committed (three-way merge). YAML frontmatter is
  merged by field: a timestamp keeps the later value, list fields keep the sorted union, and other fields keep the more
  detailed text. Overlapping body edits keep
  both blocks in a deterministic order, so every device computes the same text and the next pass converges without a
  review entry. Edits win over a concurrent deletion: the version that still has content is restored and re-published.
- Concurrent edits of an attachment or workspace: the local version stays in use and the other version is saved
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
- a restored Workspace whose original folder sits inside a Drive root is bound automatically to the same relative
  folder on this device when exactly one such folder exists and no other Workspace claims it; the placeholder is used
  only when that folder is missing or ambiguous;
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

## Opening links created on another computer

A chat synced from another device keeps the absolute path that device used. The file itself may live under a different
user folder or Drive root here, so a click on that link is resolved read-only by `/api/files/local` in this order:

1. the direct path, exactly as before;
2. progressively shorter trailing segments of the original path under the current Workspace root and then under this
device's Data root (artifacts, notes and attachments live there), longest first, with the `My Drive`/`Google Drive`
part stripped so the other device's user-folder prefix cannot block the match;
3. an exact-basename search under the Workspace root, accepted only when exactly one file matches (heavy folders are
skipped and the search is capped);
4. otherwise a precise error: the file is still inside a Google Drive folder the Drive client has not delivered, or it
was created on another computer and has not been synced here.

Suffix and basename candidates never leave the Workspace root, `..` and absolute suffixes are refused, and nothing is
created or modified. The resolved local path is what gets opened or revealed.

## Workspace file channel

The files inside a General workspace travel through a second, independent channel. It has its own remote folder
(`sync-v1/files`), its own manifests, its own scheduler queue and its own state file per Workspace
(`<agentDir>/sync/files-<account>/<hash>.json`). The batch channel described above does not read or republish it, so an
older MyHarness that only understands `sync-v1/batches` keeps syncing chats and memories and never sees these records.

**Who owns a folder** is recorded in the manifest's `descriptor`, which is part of the signed-by-hash content and takes
part in change detection:

| Source | Meaning |
| --- | --- |
| `drive` | A Google Drive sync root contains this folder. The Drive client moves the files; MyHarness only records the relative path and never uploads, deletes or rewrites those files. |
| `local` | MyHarness syncs the folder in place. On a second device it downloads into that device's own managed copy under `<workspaceFilesRoot>/<name>-<id8>`, with the same `workspaceId`. The managed root is `%LOCALAPPDATA%\MyHarness\Workspaces` on Windows (`$XDG_DATA_HOME/myharness/workspaces` elsewhere) and can be moved with `MYHARNESS_WORKSPACE_FILES_ROOT`; it stays outside the app data folder and outside a cloud client's sync root. A folder that already exists at that name is never adopted: the new copy gets a `-2` suffix. |
| `none` | Folder used on this computer only; nothing is uploaded. |

Turning MyHarness file sync on for a folder that already sits inside a detected Google Drive, OneDrive, Dropbox or iCloud
root is refused (server-side, not only by a dialog): two clients writing the same files is the failure mode this design
avoids. MyHarness does not guess ownership from a folder name. `discoverDriveRoots()` reads `MYHARNESS_DRIVE_ROOTS`
(semicolon separated), then probes the usual `My Drive` locations, and only accepts a path that exists and is a real
directory. When a Drive folder is found through a saved binding it is used as is; when the relative path exists under
exactly one detected root it is bound automatically; several indistinguishable roots or a missing folder produce a
confirmation instead of a silent choice. A folder already claimed by another identity is never taken over without an
explicit step.

**First upload (baseline).** Enabling is a two-step action: preflight (folder, file count, size, exclusion list,
possible secret files) and confirmation. The first publish is a complete snapshot, chunked at 800 operations per
manifest; the first chunk carries the descriptor and every chunk carries `{ id, index, total }`, so the receiving device
knows the full target before the last file arrives and shows `receiving` progress. A device that has not applied every
chunk keeps showing “正在接收…”, never “已一致”.

**Ongoing changes.** A scan hashes files with a bounded buffer and caches `(size, mtime) -> hash`, so an unchanged
folder costs a stat per file, not a re-read. Adds, edits, deletes and empty directories are explicit operations;
deletions are records, never inferred from a missing listing. A file changed between scan and upload is re-hashed after
the upload and left for the next pass, so an object never differs from its hash. Downloads go to a
`.<name>.myharness.part` file beside the target, are verified with SHA-256, and only then replace the target; a
letter-case-only rename on Windows is applied as a rename rather than a delete plus a new file.

**Merging.** The channel keeps the last confirmed common state per path and applies the same conservative rules as the
batch channel:

- only the other side changed: apply it;
- only this side changed: upload it;
- both changed: the local file keeps its path, the other version is saved as
  `<name> (conflict <device> <time>)<ext>` beside it, and Settings lists the conflict with the choices *keep this
  computer's version*, *use the other version* and *keep both*;
- remote delete and local edit: the local file is kept and the conflict is listed;
- local delete and remote edit: the deletion stays on this device, the other version is saved as a copy, and no delete
  is published for a path this device no longer tracks;
- a path that is a file on one side and a directory on the other is refused, not overwritten.

**Deletion guard.** A pass that would publish 100 or more deletions, or at least 20 and at least 20% of the tracked
entries, or whose root is missing, holds every deletion back, keeps uploading unrelated changes, shows “已暂停传播” and
waits for **Confirm the waiting deletions**. The thresholds are adjustable safety defaults, not a substitute for the
scan-integrity rule below.

**Scan integrity.** A directory that cannot be listed (permission, I/O, a removed root) is recorded as incomplete; no
deletion is ever derived from a path below it, while healthy directories still sync and publish. The same rule applies
when the root itself disappears: the binding and state are kept, the status shows “目录暂时不可用”, and retrying is
automatic.

**Large files.** Content is hashed as a stream and uploaded in 8 MB chunks with Drive's resumable protocol; the upload
session URI and the number of accepted bytes are saved in the Workspace state, so a restart asks the old session how
much it already has and continues. Downloads use `Range`, append to the temp file and keep the offset. There is no
200 MB cap in this channel: the real limits are the account's Drive space, disk space and the local filesystem, and a
full disk or a locked file simply keeps the transfer waiting with its offset instead of pretending success.

**What is excluded, and what is not promised.** `.git`, `.svn`, `.hg`, `node_modules`, `__pycache__`, `.pytest_cache`,
`.venv`, `venv`, `.cache`, `.gradle`, `.myharness`, `*.tmp`, `*.part`, `*.crdownload`, `~$*` Office lock files,
`.DS_Store`, `Thumbs.db`, `desktop.ini` and MyHarness's own temp files are excluded and listed before the first upload.
Other hidden files and `archive/` are normal content and travel. Symbolic links and Windows junctions are not followed;
they are listed as a limitation. Secrets are detected by common file names (`.env*`, private keys, `credentials.json`,
`.npmrc`, …) and highlighted before the first upload, but detection cannot find every secret. A database or a multi-file
transactional store is copied file by file; that is not application-level consistency, so close the program or export
first. Google Docs shortcuts are not documents and are not expanded.

**Status truth.** A workspace reports who owns the files and what is actually happening: `不完整`, `正在接收 x/y`,
`等待上传 n 项`, `有 n 个文件冲突`, `删除已暂停`, `目录暂时不可用`. “本机当前更改已上传，截至 HH:mm” is only shown when
nothing is pending, the last scan was complete, no conflict is open, no deletion is blocked and no error is recorded.
For a Drive-managed folder it says “文件由 Google Drive 客户端同步。MyHarness 无法确认其上传是否完成。” A finished
chat upload never changes any of these sentences.

**History.** Replaced and deleted files are copied to `<agentDir>/sync/backups/workspace-file/…` before the change, and
resolving a conflict forms a new version rather than rewinding local state. Cleanup of old versions is not implemented:
the status says so and space grows until a later policy exists.

**Failure containment.** Several rules exist so that a bad pass cannot lose data or claim success:

- A state file written by a newer MyHarness is kept read-only and never rewritten with an empty base, so an upgrade does
  not lose the index or trigger a re-upload; the Workspace shows “同步状态由更新版本的 MyHarness 写入”.
- A manifest that cannot be read, a manifest with an unknown version and a manifest whose files keep failing are never
  marked as applied. They stay pending and are retried after a cooldown, so a temporary Drive or network failure cannot
  silently drop a file for good.
- A change to a path below a folder that could not be listed, or below a root that is not available, fails and keeps the
  manifest pending instead of deleting or rewriting anything.
- A file that cannot be hashed twice is left in place and is not published as a deletion.
- While a first snapshot is still arriving, the receiving device publishes no deletions: it has not seen the whole folder
  yet.
- Overwriting or deleting a local file requires a copy first. If the copy cannot be written (disk full, permission), the
  operation is refused and the file stays.
- A remote path containing `..`, a drive letter, a backslash or a Windows device name is refused, and a path whose parent
  is a junction or symlink is refused too.
- Turning file sync on refuses a folder that overlaps another Workspace with file sync already on, in either direction:
  two engines scanning the same tree would fight over it.
- The folder MyHarness creates copies in is refused when it would itself sit inside a cloud sync root; set
  `MYHARNESS_WORKSPACE_FILES_ROOT` to a local folder outside cloud sync instead.

## Local state and credentials

Everything device-specific lives below `<agentDir>/sync/`:

- `config.json` — device name/id, enabled, paused, OAuth client id and secret, cloud folder id, account label;
- `state-<account>.json` — vectors, tombstones, applied batches, conflicts, bindings (one file per Google account);
- `bases-<account>/` — the last content both devices committed for each memory, used as the common ancestor of a
  three-way merge. Never uploaded; one content file per hash plus an index.
- `credentials.json` — access/refresh token, written with mode 0600 and atomic replace;
- `backups/`, `recovered/` — previous and unapplied versions, at most 20 per key.

The Google token never enters the Data root, a chat, a tool result or the sync folder. It is protected by file
permissions only. It is **not** encrypted with Windows DPAPI/Electron `safeStorage` and the transfer is **not**
end-to-end encrypted: Google stores the data under the account's normal Drive protection.

## Scheduling

- Local file changes are watched and debounced (~0.8 s), then pushed.
- While the app is connected it checks for remote batches every ~10 s; idle every ~45 s.
- Every Drive request has a deadline: 30 s for metadata, 3 min for reading an object, 5 min for a write. A request that
  never answers fails that pass instead of leaving it `running` forever, so the manual buttons come back and the next
  retry is scheduled by itself. A timeout is not retried inside the same request.
- A pass applies batches one at a time, in `(createdAt, batchId)` order, because version vectors and file writes depend
  on that order; the *waiting* is what overlaps. Batch manifests are read in parallel chunks of 6, and the small objects
  (up to 8 MB) of the next batches are fetched while the current batch is written, with at most 4 object downloads in
  flight and one download per object even when a prefetch already has it. The limits stay low on purpose: a 429 would
  cost more than the parallel reads save.
- A file id learned from a listing or from a lookup is reused, so reading a batch or an object is one download rather
  than a Drive query followed by a download. The sub-folders of `sync-v1` are also resolved once instead of on every
  pass.
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

Every pass, automatic or manual, keeps listing the batches folder until nothing new is left (at most 20 rounds), uploads
up to four file contents at a time, and reports what it moves in the status's `progress = { stage: download|upload,
done, total }` (null between passes). Settings shows it as "x / y" with a bar next to "Waiting to download" / "Waiting
to upload" and in the line under the buttons, updated at most four times a second. A pass that downloaded or uploaded
something is followed by the next one after 1.5 s instead of the normal poll, so a backlog keeps flowing; automatic
passes also retry batches skipped for a missing object or a failed apply every 10 minutes.
- **Download now** — download only. It waits for a pass that is already running, then keeps listing the batches folder
  until nothing new is left (bounded to 20 rounds), so batches that arrive during a long download are fetched too. It
  also gives batches skipped earlier for a missing object or a failed apply another chance. Nothing is uploaded.
- **Sync now** — the same complete download followed by the upload of everything waiting on this computer.

Download now and Sync now answer at once (409 when sync is paused, Drive is not connected or a manual run is already
going) and report progress through the status: `manual = { kind, state: running|done|failed, stage, done, total,
remainingDownloads?, error? }`. The row shows "Downloading… x / y", "Uploading… x / y", the finish or the failure
reason; both buttons are disabled while one runs. While the run waits for a pass that is already in flight, the row says
what that pass is doing and how much is left ("downloading, N batches left" / "uploading, N changes left") instead of
only "waiting", and the per-request deadlines above guarantee that wait ends. Pause means nothing is uploaded or
applied, so while paused both buttons are disabled and the routes refuse; Check now keeps its old behaviour (a pass
that does nothing while paused).

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
| `POST /api/sync/workspace-source` | `{ workspaceId }` which engine owns the folder, and the Drive relative path |
| `POST /api/sync/files/preflight` | `{ workspaceId }` first-upload summary: files, size, exclusions, possible secrets |
| `POST /api/sync/files/enable` | `{ workspaceId, source, confirmed, driveRootId?, driveRelativePath? }`; a `local` first upload is refused unless `confirmed` is true, and the Drive root and relative path are recomputed on the server from the detected root |
| `POST /api/sync/files/disable` | `{ workspaceId }` stop managing files, keep them in place |
| `POST /api/sync/files/resolve` | `{ workspaceId, conflictId, choice: keep-local\|take-remote\|keep-both }` |
| `POST /api/sync/files/confirm-deletes` | `{ workspaceId }` release a held bulk deletion |
| `POST /api/sync/occupancy` | `{ workspaceId, rootPath }` which Workspace already claims the folder |
| `POST /api/sync/release-occupant` | `{ workspaceId, confirmed: true }` move a hidden Workspace's binding to `<dataRoot>/workspace-folders/reserved-<id8>`, keeping its chats; both the route and the service refuse the call without the flag |

## Limits and not-yet-verified behavior

- Real Google OAuth, two physical machines, folder rename, revoked authorization, quota exhaustion and Drive outage
  behavior have not been run against a live account; only the in-memory Drive tests are executed.
- Background sync stops when MyHarness quits and continues on the next start. Tray support and launch-at-login are not
  implemented, so after a reboot nothing uploads until MyHarness is opened.
- Batches over 5000 operations written by another client are refused; this daemon never writes such a batch itself.
- Conflicts for chats and drafts are kept for review but there is no “apply the other version” button yet; the copy
  path is shown. Memories no longer create review entries: they merge automatically.
- The `snapshots/` folder is part of the layout but snapshots are not used yet for faster bootstrap.
- Workspace files that live outside the MyHarness Data root are synced by the file channel only when the user turns it
  on; a Drive-managed folder is never uploaded by MyHarness, because `drive.file` only grants access to files this app
  created and double management is refused on purpose.
- Real Google resumable upload and `Range` download against a live account, and a real two-computer transfer, have not
  been executed here. The protocol, resume bookkeeping, checksum verification, conflict handling and deletion guard are
  covered by `test/workspace-file-sync.test.ts` with an in-memory transport.
- The file channel does not detect renames heuristically: a rename is published as a new path plus a delete of the old
  one only after the new content is safely uploaded, so the result is correct even when it costs a re-upload.
- Symbolic links, junctions and special files are not followed or copied in this version; they are reported once.
- Each Workspace keeps the names of at most 2000 applied manifests. A Workspace that publishes more manifests than that
  without a fresh snapshot can have an old manifest re-read; its operations are then evaluated against the current base,
  which produces a listed conflict rather than an overwrite, but it is noise. Cleaning up the append-only remote log is
  the later fix.
- Version history has no restore button yet: kept copies and Drive revision history exist, but restoring a version is a
  manual file operation.
- There is no end-to-end encryption for workspace files, exactly as for chats and memories; uploaded content and history
  consume the account's Google storage.
- The three existing unbound workspaces have not been touched: their binding needs an explicit confirmation in
  Settings, and the hidden-record release is offered only for a Workspace that is no longer in the sidebar.
- A chat whose header becomes unreadable or whose mode is switched to Coding is kept locally instead of being deleted,
  and is not republished until it is written again.
- A symlinked directory inside the Data root is refused as a safety measure, so a user who deliberately links a folder to
  another disk sees an error instead of a silent write. A Windows junction is not reported as a link by the filesystem
  API, so the Data root should stay on a real directory.
- Handled batches are remembered per device as a watermark (`appliedUpTo`: the newest batch time up to which every
  listed batch of that device is handled) plus a short list of handled names above the first batch still waiting. The
  watermark only passes a time when every batch of that device up to it is handled, so a deferred batch is never
  skipped, and batches a manual run reopens stay open (`reopenedBatches`) until they are handled again. Before this, the
  log kept only the last 2000 names, so a Drive folder with more batches than that downloaded its oldest batches again
  on every pass (shown as a backlog of hundreds of "waiting to download" items). A state written by the old version
  whose list is already full treats the batches older than each device's oldest remembered one as handled.

## Tests

```powershell
npm.cmd --workspace packages/coding-agent run test -- test/google-drive-sync.test.ts
npm.cmd --workspace packages/coding-agent run test -- test/workspace-file-sync.test.ts
```

`test/workspace-file-sync.test.ts` covers the file channel: first snapshot and reconstruction on a second device with
its own folder and the same workspace id, add/edit/delete in both directions, an interrupted download that resumes and
publishes no false deletion, both-modified conflicts with a saved copy and convergence after `keep-local`, a subtree
that cannot be scanned never producing deletes while healthy paths still sync, the bulk-deletion guard and its
confirmation, a Windows case-only rename, an unknown manifest version kept read-only, the first-upload preflight, Drive
relative-path location with an ambiguous-root refusal, hidden-occupant release that keeps its chats, and Drive-root
discovery from the declared environment variable.

`test/google-drive-sync-resume.test.ts` covers resuming: a manifest Drive accepted just before the app stopped is
committed without a second batch or upload, a manifest that never arrived is published again with the objects reused,
a large upload resumes after its last published batch, offline changes stay counted and upload once the network is
back, a failing download does not block the upload, a full disk keeps the batch waiting, and the manual Download now /
Sync now runs (draining batches that arrive during the run, retrying a skipped batch, waiting for a running pass,
refusing while paused).

The suite covers: first upload and restore on a second device, memory deletion without resurrection, automatic
three-way merge of concurrent memory edits until both devices hold the same text (and no further batch is published),
an edit restoring a memory deleted concurrently, a legacy review copy merged on the next pass, chat branch merge, draft
and prompt deletes, concurrent delete-vs-edit for chats and drafts, missing
objects deferring a batch, no re-reading of already applied batches, a large change set split into several batches, an
ignored self-batch, refused hostile identities, a damaged batch reported once, an object that never arrives reported
and skipped, archive markers and ordinary JSON files beside artifacts, a Workspace removed from every list, a chat
entry conflict that keeps a recoverable copy even when the merge changes nothing, and a remote timestamp that tries to
steer the write outside the chat folder.
