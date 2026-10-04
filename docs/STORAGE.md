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
| `%USERPROFILE%\.myharness\agent\memory\` | Optional global/project memory and its indexes | User-authored or model-assisted data; preserve and redact before sharing |
| `<project>\.myharness\settings.json` | Project Settings | Project-local configuration; tracked only when intentionally supplied |
| `<project>\data\workspaces\<workspace-id>\` | Workspace registry, metadata and Session roots | Ignored runtime data; contains user conversations and paths |
| `<project>\data\workspaces\<workspace-id>\sessions\<session-id>\conversation\` | Session JSONL entries | Primary product Session store; user data, not disposable build output |
| `%USERPROFILE%\.myharness\agent\code-intelligence\` | Optional downloaded semantic modules and workspace/index data | Installed runtime outside the source tree; only install published, checksummed assets |

The default product Session format is JSONL plus JSON metadata. The separate
`packages/storage/sqlite-node` package implements a Node SQLite backend, but
the current Coding Agent default path is still the project `data/workspaces/`
tree. It must not be described as the active product storage backend without a
runtime change and corresponding tests.

Web file imports are stored alongside the originating Session JSONL in
`uploads/<random-id>/attachment-<sanitized-name>`. Each import has a separate
directory, so matching names do not overwrite one another. These are user-owned
original file bytes; removing a draft attachment only removes its reference, not
the stored file. Structured Session deletion removes them with the Session data
directory; they must not be treated as disposable build cache.

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
actual files, refreshed after file/shell tools and when browsing artifacts. They
can be rebuilt without duplicating reports. The Web Files panel has an Artifacts
view for the current chat, current Workspace and all Workspaces; files can be
downloaded and every entry carries its Workspace/Session identity.

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

Deleting a chat defaults to preserving artifacts and a minimal
`metadata/artifacts-origin.json` provenance record; chat contents, tool results
and imported attachments are removed. Workspace/global references remain and mark
the source chat deleted. The deletion UI offers an unchecked option to permanently
delete artifacts too; that removes the original files and their derived references,
not other chats' output. Bulk chat deletion follows the same backend default.

Removing a Workspace still only unregisters it: project files and chats are not
deleted. Its optional artifact-deletion choice removes only that Workspace's
artifacts; keeping them leaves them available globally. Deleting artifacts refuses
symbolic links/junctions rather than traversing indirect user-owned targets.

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
