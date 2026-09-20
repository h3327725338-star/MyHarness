# Code Intelligence Router

`CodeIntelligenceRouter` binds one normalized workspace root and routes unified
Code Intelligence domain queries to injected backends. It owns routing policy
only:

- `LspSemanticBackend` owns semantic sessions, document synchronization, and
  the injected `LanguageServerManager` owns server lifecycle.
- `LightweightCodeIntelligenceBackend` owns the `CodeSymbolIndex` adapter and
  converts legacy symbols and references into the unified domain.
- The router does not construct a manager, semantic backend, or `LspClient`.
- The router has no global singleton, result cache, health cooldown, ranking, or
  cross-backend fusion.

## Routing matrix

| Operation | `auto` | `semantic` | `lightweight` |
| --- | --- | --- | --- |
| `findSymbol` | lightweight | unsupported | lightweight |
| `fileSymbols` | semantic, safe fallback only | semantic | lightweight |
| `findDefinition(position)` | semantic | semantic | unsupported |
| `findDefinition(name_path)` | lightweight | unsupported | lightweight |
| `findDefinition(symbol_id)` | unsupported | unsupported | unsupported |
| `findReferences(position)` | semantic | semantic | unsupported |
| `findReferences(name_path)` | lightweight | unsupported | lightweight |
| `findReferences(symbol_id)` | unsupported | unsupported | unsupported |
| `findImplementations(position)` | semantic | semantic | unsupported |
| `findImplementations(name_path/symbol_id)` | unsupported | unsupported | unsupported |
| `getDiagnostics` | semantic | semantic | unsupported |

Position targets never fall back to lexical names. Lightweight references are
explicitly lexical and do not claim target identity. A real fallback is only
used for `auto` `fileSymbols` when semantic is not configured, document symbols
are unsupported, the server is genuinely unavailable, or the position encoding
is unsupported. Semantic empty and partial results, initialize/start/request/
timeout/abort/synchronization/protocol/conversion errors, and explicit
`definitionId` failures remain errors.
