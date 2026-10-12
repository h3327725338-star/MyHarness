# Code Intelligence Router

`CodeIntelligenceRouter` binds one normalized workspace root and routes Symbols
queries to the injected semantic/LSP backend. It owns routing policy and
Symbol Store coordination only:

- `LspSemanticBackend` owns document synchronization, diagnostics and conversion
  from LSP responses to the semantic domain model.
- `LanguageServerManager` owns language-server selection, process lifetime,
  workspace isolation and crash replacement.
- `SymbolStore` owns observed `symbol_id` records used to resolve later queries.
- The router does not construct a manager, semantic backend or `LspClient`, and
  it has no lexical fallback, result cache, health cooldown, ranking or
  cross-backend fusion.

## Routing policy

There is one query backend: `semantic`. The router does not expose an `auto`
or fallback mode. Unsupported targets and unavailable semantic services return
structured router/backend errors instead of lexical results.

| Operation | Accepted input | Backend / behavior |
| --- | --- | --- |
| `fileSymbols` | workspace-relative file path | semantic document symbols |
| `workspaceSymbols` | query, with optional path/kind filters | semantic workspace symbols |
| `resolveSymbol` | stored `symbol_id` | refreshes semantic file symbols and resolves through Symbol Store |
| `hover` | position or stored `symbol_id` | semantic hover at a precise position |
| `findDefinition` | position or stored `symbol_id` | semantic definition |
| `findReferences` | position or stored `symbol_id` | semantic references |
| `findImplementations` | position or stored `symbol_id` | semantic implementations |
| `diagnostics` | workspace-relative file path | semantic diagnostics |
| `incomingCalls` | position or stored `symbol_id` | semantic call hierarchy |
| `outgoingCalls` | position or stored `symbol_id` | semantic call hierarchy |
| `supertypes` | position or stored `symbol_id` | semantic type hierarchy |
| `subtypes` | position or stored `symbol_id` | semantic type hierarchy |

Name-based targets are not part of the Symbols tool contract. A stored
`symbol_id` is resolved against the current semantic file symbols before a
position-based operation runs; stale or unresolvable IDs remain errors.

The semantic backend's empty or partial result is preserved as such. Initialize,
start, request, timeout, abort, synchronization, protocol and conversion errors
remain structured errors and are never silently replaced with lexical output.
