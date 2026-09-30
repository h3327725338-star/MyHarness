# Sessions

MyHarness saves conversations as sessions so you can continue work, branch from earlier turns, and revisit previous paths.

## Session Storage

By default, Sessions are stored below the project data root and are grouped by stable Workspace and Session identities:

```text
data/
└─ workspaces/<workspace-id>/
   └─ sessions/<session-id>/
      ├─ metadata/session.json
      └─ conversation/<timestamp>_<session-id>.jsonl
```

The Workspace registry is `data/workspaces/registry.json`; it is the authoritative list for `/workspace`, and each Workspace also has metadata under its own `metadata/` directory. On load, missing or stale metadata is repaired from the registry and a missing workspace root is reported without creating a replacement record. Workspace identity comparisons use the canonical filesystem identity (case/slash/`.`/`..`, junction, and Windows long/8.3 aliases do not create another record), while the stored path keeps the resolved caller spelling. `data/sessions/` is only an explicit legacy migration source: normal startup, Session listing, and new Session creation do not read or write it. After a clean migration, the retired tree is removed once only empty directories remain. Each conversation remains a JSONL file with a tree structure.

Workspace-level data belongs beside `sessions/`, for example `docs/` and `instructions/`. Session-level data belongs inside `sessions/<session-id>/`, for example `metadata/`, `conversation/`, `files/`, `notes/`, and `tool-results/`. The storage path helpers in `src/config/paths/` and the Workspace resolver in `src/data/workspace-store.ts` are the shared path boundary; callers should not construct these paths independently.

The one-time registry cleanup writes `.workspace-registry-migrated.json`. Known test-temporary roots are removed from the active registry only after their Session headers are verified and are recorded in `.unresolved-workspaces.json`; their Workspace directories are retained. Records that cannot be proven safe remain active and are listed as unresolved.

Sessions that belong to no Workspace are kept in the reserved container `data/workspaces/unbound/` (it is never written to the registry, so it is not a Workspace) and run in MyHarness's own default working directory, `<agent dir>/default-workspace/`. Removing a Workspace from the registry moves nothing: its `workspaces/<workspace-id>/` directory, the project folder and every Session stay where they are, and those Sessions are simply unbound (`SessionManager.isUnbound()`, `SessionManager.listUnbound()`). Adding the same folder again reuses the old Workspace ID, which reattaches them. `SessionManager.createLike()` keeps an unbound Session unbound, so "new session" never re-registers a removed Workspace.

The `/workspace` sidebar lists only active registry Workspaces. Expanding one reads Sessions from that Workspace's `sessions/<session-id>/` tree; an unregistered current directory is not shown as a synthetic Workspace.

SDK hosts can pass `dataRoot` to `createAgentSession` or `SessionManager` storage options when they need an isolated Data root. The `MYHARNESS_DATA_ROOT` environment override is intended for the same host/test isolation case; an explicit project root passed to migration APIs remains authoritative.

```bash
myharness -c                  # Continue most recent session
myharness -r                  # Browse and select from past sessions
myharness --no-session        # Ephemeral mode; do not save
myharness --name "my task"    # Set session display name at startup
myharness --session <path|id> # Use a specific session file or partial session ID
myharness --session-id <id>   # Open or create the exact project session ID
myharness --fork <path|id>    # Fork a session file or partial session ID into a new session
```

`--session` resolves a file path or partial ID and fails when it cannot find a match. `--session-id` requires an exact ID made from alphanumerics, `.`, `_`, or `-`; the ID must start and end with an alphanumeric character. It opens the matching session for the current project or creates a new session with that ID. It cannot be combined with `--session`, `--continue`, or `--resume`. When combined with `--fork`, it becomes the ID of the new fork.

For the JSONL file format and SessionManager API, see [Session Format](session-format.md).

## Built-in Session Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new session |
| `/compact [prompt]` | Summarize older context; see [Compaction](compaction.md) |

Additional session commands (resume, fork, clone, tree, export, share, etc.) may be provided by extensions.

## Resuming and Deleting Sessions

`MyHarness -r` opens an interactive session picker at startup.

In the picker you can:

- search by typing
- select a session to resume

When available, MyHarness uses the `trash` CLI for deletion instead of permanently removing files.

## Naming Sessions

Set the name at startup with `--name` or `-n`:

```bash
myharness --name "Refactor auth module"
myharness --name "CI audit" -p "Review this build failure"
```

Named sessions are easier to find in `MyHarness -r`.

## Branching with Session Tree

Sessions are stored as trees. Every entry has an `id` and `parentId`, and the current position is the active leaf. Extensions may provide tree navigation to jump to any previous point and continue from there without creating a new file.

Example shape:

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### Tree Controls

Tree navigation controls are provided by extensions.

### Selection Behavior

Selecting a user or custom message:

1. Moves the leaf to the selected message's parent.
2. Places the selected message text in the editor.
3. Lets you edit and resubmit, creating a new branch.

Selecting an assistant, tool, compaction, or other non-user entry:

1. Moves the leaf to that entry.
2. Leaves the editor empty.
3. Lets you continue from that point.

Selecting the root user message resets the leaf to an empty conversation and places the original prompt in the editor.

## `/new`, Fork, and Clone

| Feature | `/new` | Fork (`MyHarness --fork`) | Clone |
|---------|--------|---------------------|-------|
| Output | New session file | New session file from existing | New session file |
| View | Empty | User-message selector via extension | Current active branch |
| Typical use | Start fresh | Start a new session from an earlier prompt | Duplicate current work before continuing |

## Branch Summaries

When navigating from one branch to another, MyHarness can summarize the abandoned branch and attach that summary at the new position. This preserves important context from the path you left without replaying the whole branch.

See [Compaction](compaction.md) for branch summarization internals and extension hooks.

## Session Format

Session files are JSONL and contain message entries, model changes, thinking-level changes, labels, compactions, branch summaries, and extension entries.

For parsers, extensions, SDK usage, and the full SessionManager API, see [Session Format](session-format.md).
