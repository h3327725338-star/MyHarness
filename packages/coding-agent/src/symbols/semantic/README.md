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

The first semantic backend supports document symbols, definitions, references,
implementations, diagnostics, and `didOpen`/`didChange`/`didClose`. It uses the
workspace file on disk as the document source of truth, supports UTF-16
positions, and uses a whole-document replacement edit for incremental sync.

Semantic failures are structured errors. The backend does not fall back to the
lightweight index, modify the Symbols tool, implement hover or workspace
symbols, or provide a persistent semantic cache.
