# Semantic LSP Backend

Phase 5 adds a document-scoped semantic backend on top of the existing
`LanguageServerManager` and `LspClient` layers.

## Ownership

- `LspSemanticBackend` owns document synchronization state, diagnostic
  subscriptions, and conversion from protocol values to the unified Code
  Intelligence domain model.
- `LanguageServerManager` owns server selection, process lifetime, workspace
  isolation, and crash replacement.
- `LspClient` owns JSON-RPC request/notification transport and request
  lifecycle.

The backend never constructs an `LspClient`, selects a registry definition, or
disposes an injected manager. A document state is keyed by the actual managed
client instance and file URI, so a replacement client after a crash receives a
fresh `didOpen` notification.

Definition and implementation target-symbol resolution uses the same managed
`LanguageServerDefinition` as the source request. This prevents a target file
from silently switching to a different provider. If that definition does not
support the target file's language, the result is partial with a warning.

## Scope

The semantic backend supports document symbols, definitions, references,
implementations, diagnostics, workspace symbols, hover, call hierarchy, type
hierarchy, and `didOpen`/`didChange`/`didClose`. It uses the workspace file on
disk as the document source of truth, supports UTF-16 positions, and uses a
whole-document replacement edit for incremental sync.

`rename` returns workspace-relative text edits from `prepareRename` +
`textDocument/rename`. Resource operations (create/rename/delete file),
out-of-workspace edits, edits needing user confirmation, and malformed entries
are reported in `unsupportedChanges` instead of being dropped; the caller
(`symbols/workflow/rename.ts`) refuses a plan that has any. Locations sent as
plain absolute Windows paths instead of `file:` URIs (kotlin-language-server)
are accepted.

## Cross-file readiness

A cross-file answer is only as complete as the server's index. Before
references, rename, implementations, call/type hierarchy, and workspace
symbols the backend:

1. re-reads every open document from disk and sends `didChange` (or
   `didClose` when the file is gone), so edits by other tools, editors, or Git
   are seen;
2. lists the workspace files of the server's languages (ripgrep, at most every
   2 s, up to 20,000 files) and sends `workspace/didChangeWatchedFiles` for
   files created, changed, or deleted since the previous scan (the first scan
   of a session is the baseline);
3. waits, bounded (20 s or half the request timeout), while the server reports
   work-done progress, or while rust-analyzer's `experimental/serverStatus`
   says it is not quiescent (that status, when present, replaces progress
   tokens, since `cargo check` keeps one open); still busy means a warning and
   `completeness=partial`;
4. for references and rename on a server that never reported progress outside
   our own requests, re-runs the query (750 ms apart, at most 8 times) while
   the session is younger than 10 s, or after file changes were just sent, in
   which case the answer must also hold 4 s past the notification (the
   bundled PHP server re-indexes after its own debounce); an answer that never
   settles is returned with a warning;
5. retries `ContentModified`/`ServerCancelled` responses up to 3 times.

clangd sessions without `compile_commands.json`, `compile_flags.txt`, or
`build/compile_commands.json` carry a warning that cross-file results are
limited to the current file. Client capabilities announced at `initialize`
come from `lsp/client-capabilities.ts` (hierarchical document symbols, rename
with prepare support, text-only workspace edits, work-done progress), and
per-server `initializationOptions` from `runtime/server-options.ts`
(`typescript-language-server` uses the semantic server only, so references and
rename see the whole project at cold start).

Semantic failures are structured errors. The backend does not fall back to a
lexical index or modify the Symbols tool, and it does not provide a persistent
semantic cache.
