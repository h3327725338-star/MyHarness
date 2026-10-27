# MyHarness storage and data boundaries

This page records the current source-backed storage layout. It is an
operational guide, not a promise that every future backend will use the same
format.

## User and project roots

Unless an environment override is configured, the global Agent directory is:

```text
%USERPROFILE%\.myharness\agent\
```

The project root contains the project configuration and runtime data:

```text
<project>\.myharness\settings.json
<project>\data\
```

`MYHARNESS_CODING_AGENT_DIR` changes the global Agent directory.
`MYHARNESS_DATA_ROOT` changes the project data root. The path resolver in
`packages/coding-agent/src/config/paths/index.ts` is authoritative.

## What is stored where

| Location | Contents | Ownership and handling |
| --- | --- | --- |
| `%USERPROFILE%\.myharness\agent\settings.json` | Global Settings | User configuration; do not commit or delete as cleanup |
| `%USERPROFILE%\.myharness\agent\auth.json` | Provider credentials | Sensitive user data; never print, commit, or attach unredacted |
| `%USERPROFILE%\.myharness\agent\models.json` and `models-store.json` | Provider/model configuration and cached catalog metadata | Configuration/cache; catalog data is not a secret, credentials are |
| `%USERPROFILE%\.myharness\agent\trust.json` | Project trust decisions | User security state; preserve unless the user explicitly asks to reset it |
| `%USERPROFILE%\.myharness\agent\sessions\` | Legacy flat Session location | Compatibility/migration source only; do not treat it as the current default |
| `%USERPROFILE%\.myharness\agent\traces\` | Runtime traces | Potentially sensitive diagnostics; redact before sharing |
| `%USERPROFILE%\.myharness\agent\memory\` | Legacy memory migration source | Copied once per source Agent directory into the active Data root; originals preserved |
| `<data>\memory\` | Global active memories, archive, derived index, extraction state and migration records | Shared only within this Data root; user-owned data |
| `<data>\workspace-folders\` | General quick-created physical workspace folders | Same resolved Data root as the registry; existing workspace paths never move |
| `<data>\workspaces\<workspace-id>\uploads\<source-id>\` | General workspace source file and `source.json` manifest | Shared across its chats; independent of session attachments; disabling library access does not delete files |
| `<data>\workspaces\<workspace-id>\memory\` | Workspace active memories, archive and reference index | Shared by this Workspace's conversations |
| `<data>\workspaces\<workspace-id>\sessions\<session-id>\memory\` | Conversation active memories and archive, plus its memory maintenance job and log | Retained when the conversation is deleted unless its memories are explicitly deleted with it; a folder holding only the maintenance job/log is not retained |
| `<data>\trash\` | What a chat deletion removes, moved here first (one folder per deletion) | Local-only, never synced; a folder left behind because a file was still open is removed by a later deletion |
| `<project>\.myharness\settings.json` | Project Settings | Project-local configuration; tracked only when intentionally supplied |
| `<project>\data\workspaces\<workspace-id>\` | Workspace registry, metadata and Session roots | Ignored runtime data; contains user conversations and paths |
| `<project>\data\workspaces\<workspace-id>\sessions\<session-id>\conversation\` | Session JSONL entries | Primary product Session store; user data, not disposable build output |
| `%USERPROFILE%\.myharness\agent\code-intelligence\` | Optional downloaded semantic modules and workspace/index data | Installed runtime outside the source tree; only install published, checksummed assets |
| `%USERPROFILE%\.myharness\agent\desktop-profile\` | The desktop app's Electron profile: built-in browser cookies and site storage, `browser-*.json` stores (bookmarks, new-tab shortcuts, zoom, dark mode, language, permissions), encrypted saved passwords, and the browser sync key and per-computer sealed vaults | Sensitive user data; never print or attach. Drive sync carries only those six store files and the sealed vaults, never the key, cookies or password file (see `packages/desktop/README.md`) |

The default product Session format is JSONL plus JSON metadata. The separate
`packages/storage/sqlite-node` package implements a Node SQLite backend, but
the current Coding Agent default path is still the project `data/workspaces/`
tree. It must not be described as the active product storage backend without a
runtime change and corresponding tests.

Web file imports are stored in the originating Session folder as
`uploads/<random-id>/attachment-<sanitized-name>` with a `manifest.json` beside
the file (a legacy flat Session without a Workspace/Session folder keeps them in
`uploads/<random-id>/` beside its JSONL file). Each import has a separate
directory, so matching names do not overwrite one another. These are user-owned
original file bytes; removing a draft attachment only removes its reference, not
the stored file. Deleting a chat keeps them (copies of the chat, such as forks,
may still refer to them); only an explicit attachment deletion removes them. They
must not be treated as disposable build cache.

## Long-term memory

Memory bodies are Markdown with metadata and are stored once at their owning global, Workspace or Conversation level. Recall uses only active global + current Workspace + current Conversation files. `archive/` is excluded from recall and stores prior versions and consolidated entries; age alone is not an archival rule. Files → Memories provides hierarchy-wide browsing and archive restoration. Restoring first archives any current version and retains the restored archive itself.

All derived indexes, extraction cursors, migration records and pending ownership data live inside the active Data root. Workspace identity is the stable Workspace ID rather than a project-path hash. Old project-path hashes are used only to match legacy files to retained Workspace metadata; ambiguous or unmatched files are copied into `memory/pending/` without becoming global. Old files are not deleted, and migration markers prevent repeat imports. Removing a Workspace does not remove its memories; their IDs remain attached to retained data. Deleting a Chat keeps its memories unless the deletion dialog's "Also delete this chat's memories" is checked. Then the Chat's own Conversation memory folder goes, and so do the global and Workspace memories (with their archives) that only this Chat wrote: each memory version records its writer in `updatedBy` (the writing chat's session id, `consolidation` or `restore`), and a version older than that field counts as this Chat's only when it came from this Chat's extraction (`sourceSessionId`, no `sourceEntryId` repeated across versions) or from a `memory_write` creation recorded in this Chat's history. Memories that another chat, consolidation or a restore also changed, the resident profile and `memory/pending/` are kept. One memory can be permanently deleted with `memory_delete` or `POST /api/memory/delete` (body and all archives).

## Managed Worktree test services

Display-only names are stored in `<agent>/worktrees/names/<path-id>.json`.
Managed copy services use `<agent>/worktrees/services/<path-id>/` for private
Agent configuration, sessions, data, startup logs and a loopback service identity
record. Selected model/credential files are copied only on first startup;
these private snapshots contain secrets and must never be committed or exposed.
They are not a filesystem sandbox. Names do not change Git branch or path identity.

## Conversation-owned artifacts

Temporary reports, research, plans, disposable verification scripts, test results
and intermediate files default to a single conversation-owned location:

```text
< data root >/artifacts/{index.json,README.md}             global references
< data root >/workspaces/<workspace-id>/artifacts/         workspace references
< data root >/workspaces/<workspace-id>/sessions/<session-id>/artifacts/
  reports/      reports and research
  tests/        disposable scripts and results
  temporary/    intermediate files
```

Only the Session directory holds file bytes. Parent indexes are derived from
actual files and can be rebuilt without duplicating reports. After a file/shell
tool only the chat that ran it is updated in them, and only when its artifacts
changed; the All workspaces view and chat deletion rebuild them completely, and
a file whose content is unchanged is not rewritten. One walk checks each folder
for symbolic links/junctions once, not once per file below it. The Web Files
panel has an Artifacts view for the current chat, current Workspace and all
Workspaces (the first two read just their own folders); files can be downloaded
and every entry carries its Workspace/Session identity.

Persisted structured Sessions receive their artifact path in the runtime prompt.
Shell tools also expose `MYHARNESS_ARTIFACTS_DIR` and `MYHARNESS_TEMP_DIR` without
changing cwd or globally redirecting TEMP/build output. This is an Agent default,
not a filesystem sandbox: explicit user paths win, and arbitrary shell programs
can still write elsewhere. Permanent source, maintained tests and official project
docs remain in their usual paths. Legacy/custom flat and in-memory Session stores
do not receive this structured artifact policy.

The repository's `/data/` ignore protects the default tree. Artifact roots and
parent index directories also create a local `.gitignore` containing `*`, useful
with a different data root. Existing tracked files and `git add --force` are not
made safe by ignore rules. Never auto-move files solely by filename heuristics.

Deleting a chat removes its conversation and metadata. By default it keeps its
artifacts with a minimal `metadata/artifacts-origin.json` provenance record, its
imported uploads, its tool results and its memories; an artifacts folder holding
no file (only the empty reports/tests/temporary scaffold) is not kept. Deletion is
all-or-nothing: everything that goes is first moved by rename into `<data>/trash/`,
and when a file of it is open in another program nothing is deleted and the chat
stays as it was (files that are kept may stay open). Workspace/global references
remain and mark the source chat deleted. The deletion UI offers an unchecked option to permanently
delete artifacts too; that removes the original files and their derived references,
not other chats' output. Bulk chat deletion follows the same backend default.

Removing a Workspace still only unregisters it: project files and chats are not
deleted. Its optional artifact-deletion choice removes only that Workspace's
artifacts; keeping them leaves them available globally. Deleting artifacts refuses
symbolic links/junctions rather than traversing indirect user-owned targets.

## Rich-file extraction cache

The shared General/Coding `read` implementation checks derived results in order:
Session `artifacts/temporary/extracted/`, Workspace `cache/extracted/`, then
Data-root `cache/extracted/`. Session imports write to the Session tier, files
inside the active Workspace write to the Workspace tier, and unbound/external
files write to the Data-root tier. Keys include absolute source path (case-folded
on Windows), size, mtime, parser version and image-processing options. Changed
source metadata produces a new key; old entries are not deleted automatically.
Cache write failures do not prevent reading. Document page corpora now default
to the selected tier's `corpus/` rather than the legacy Agent directory.

Derived results contain JSON metadata, a Markdown extraction and image bytes.
No extraction files are written beside source documents. These caches can contain
private document content and must not be committed. Legacy/custom SDK callers
without a structured Session fall back to the configured Data root.

## Lifecycle and cleanup rules

- `data/`, global Agent data, Session files, credentials, traces, memory and
  downloaded Code Intelligence modules are runtime/user data, not source-tree
  cleanup targets.
- Build output such as `dist/` and local dependency directories can be
  regenerated, but removal still requires checking the actual Git status and
  target path first.
- Workspace and Session migration code retains compatibility paths. A legacy
  path is not evidence that the application still writes new data there.
- Session deletion, credential reset, trust reset and runtime-module removal
  are separate user-facing operations. Do not combine them into a repository
  cleanup command.

For a security/reporting boundary, see [SECURITY.md](../SECURITY.md). For the
source implementation and migration contracts, see
[ARCHITECTURE_AND_DEVELOPMENT.md](../ARCHITECTURE_AND_DEVELOPMENT.md) and the
Coding Agent Session documentation.
