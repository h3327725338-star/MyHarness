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
