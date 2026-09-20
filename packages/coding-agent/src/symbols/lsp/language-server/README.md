# Language Server Manager

Phase 4 provides process lifecycle and routing infrastructure for language
servers. It does not implement semantic LSP requests, document synchronization,
diagnostics UI, installers, or a replacement for the existing Symbols Tool.

## Responsibilities

- `LanguageServerDefinition` is immutable startup configuration. It describes a
  command, arguments, supported language IDs, priority, and initialize options.
- `LanguageServerRegistry` validates definitions and returns deterministic
  candidates by normalized language ID, priority, and registration order. It
  does not start processes.
- `LanguageServerManager` owns runtime clients. It starts and initializes one
  client per definition ID plus normalized workspace identity, reuses ready
  clients, and disposes them.

The instance cache key is the definition ID plus an absolute normalized
workspace root. On Windows the cache identity is case-insensitive. Symlinks are
not resolved, so different symlink paths remain different workspace identities.

## Routing and failures

Callers provide an explicit `workspaceRoot`. A language can be supplied
directly, or inferred from a file path through the existing
`getCodeLanguage()` detector. The manager falls back to a lower-priority
definition only when the selected process command is unavailable (`ENOENT`). A
server that starts but rejects `initialize` is a real startup failure and is not
silently replaced by another definition.

Unexpected client failure is observed lazily: the next acquire sees the failed
client, evicts and disposes it, and starts a new instance for the same key. The
manager never runs an automatic restart loop.

## Known limitations

- No built-in external server definitions are registered by default; hosts must
  inject definitions and are responsible for installing their commands.
- A manager instance represents a repository-level workspace root. It does not
  discover project roots or walk parent directories.
- There is no idle timeout or automatic shutdown policy.
