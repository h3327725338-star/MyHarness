# Symbols contract and validation

Symbols is an optional structure/navigation tool (`codeIntelligence.symbolsEnabled`, off by default). It does not replace compilation or runtime tests. `createSymbolsTool` and `createSymbolsToolDefinition` remain exported from the Coding Agent package.

## Inputs and coordinates

Use an operation and only that operation's fields. The model-visible schema hoists repeated validators to root properties to reduce per-request overhead; closed operation branches still reject irrelevant fields, and direct execution validates the same matrix. All precise position inputs are **0-based line / 0-based UTF-16 character**. Output `path:line` uses **1-based lines** (columns stay 0-based); symbol IDs are opaque snapshot locators whose embedded coordinates remain 0-based for compatibility.

```json
{"operation":"find_definition","path":"src/service.ts","line":12,"character":8}
```

The original form remains supported:

```json
{"operation":"find_definition","target":{"type":"position","path":"src/service.ts","position":{"line":12,"character":8}}}
```

A JSON-encoded `target` string is accepted and validated. `symbolId` is a flat alternative to `target: {type:"symbol_id",symbolId:...}`. Workflow targets also support `path` + `name` (qualified when necessary). When flat locator fields and a legacy `target` coexist, the flat locator wins and the result warns. Missing coordinates, invalid JSON, unknown fields and unsupported operation combinations are errors, not guessed defaults. A top-level path alone never overrides a precise target. The shared `prepareArguments` hook normalizes lossless numeric strings and JSON array strings for known fields before schema validation; direct execution uses the same normalization.

## Workspace routing

- A file `path` selects its language and restricts returned locations to that file.
- A directory `path` scopes language discovery and returned locations; it is not interpreted as a source file.
- Without `path`, discover actual source languages in the current workspace, then query the relevant registered language servers. Shared TS/JS server instances are queried once, not once per extension.
- Explicit `language` / `definitionId` stays strict. An invalid explicit selector is not replaced with some other server.
- Language discovery respects the existing live-workspace file search and its ignore rules. Discovery is bounded; truncation, unsupported providers and per-server failures make the answer partial and produce warnings. Partial results from successful servers are retained.
- A representative document is synchronized before workspace lookup because some servers otherwise search no project. Server/project scope limitations are not a global proof that a symbol does not exist. Root discovery includes real fixture languages too (for example VS Code's C/C++ colorization fixtures); use `path` or `language` to avoid their extra provider work and warnings.
- At the low-level manager API, `acquireForWorkspace` with multiple registered definitions requires a language or definitionId instead of silently choosing the highest-priority unrelated language.

## Result semantics

`details` retains `source`, `completeness`, `fallback`, `warnings`, `outputTruncated` and workflow fields. Additive fields:

| Field | Meaning |
| --- | --- |
| `status` | `ok`, `empty`, `partial`, or `unsupported` |
| `emptyReason` | `no_matches`, `incomplete_query`, `no_diagnostics`, `diagnostics_not_published`, `unsupported`, or `timeout` |
| `unsupported` | No exact server capability; not an empty successful query |
| `nextCursor` | Opaque continuation for this tool instance and identical query snapshot |
| `offset`, `totalEntries` | Presentation entry offset and count (not a completeness guarantee) |
| `queryCompleteness` | Underlying query completeness, distinct from output pagination |

Type hierarchy is exact only when the server supports it. Current installed TS/Python servers may not; the tool reports `unsupported` with alternatives instead of pretending implementations are direct subtypes. The low-level semantic SDK still throws its typed unsupported-capability error.

Diagnostics synchronizes current disk text and opens the document. It uses pull diagnostics when advertised, otherwise waits at most 5 seconds for push within the overall budget. No published snapshot is `partial / diagnostics_not_published`, **not** a clean file. Missing, stale or future versions are partial. Even an empty reliable snapshot covers only that document/server, not a successful project build.

Incoming/outgoing call edges and call-site locations are deduplicated by normalized symbol identity and path/range; distinct sites and caller/callee direction are preserved.

## Bounded work and continuation

Default total tool budgets: `find_existing` **30 seconds**, other semantic/workflow queries **60 seconds**; explicit `timeoutMs` (up to 600,000) overrides. Timeouts cover the whole tool call, not each request independently. Cancellation propagates and rejects; timeout returns partial coverage and actionable narrowing/warmup guidance. A slow query emits a progress update after one second. `find_existing` retains already-ranked candidates and coverage when its deadline expires, including when a dependency never settles. Partial outline/workspace lookup warnings and failed lookup coverage remain partial instead of being promoted to a complete discovery; even cached outlines honor cancellation.

Default `maxChars` stays **20,000**, range 1,000–100,000. Results paginate on complete entries, never through a JSON locator. Repeat the same operation/arguments with `cursor: <nextCursor>`; `maxChars` may be increased without changing the query. Continuation reads an in-memory snapshot, not a second LSP request. Cursors expire after five minutes, are local to one tool instance/workspace, and retain the original result even if source files change: rerun without cursor for fresh evidence. The cache holds at most eight snapshots / eight million characters (not bytes); oversized snapshots are not retained and explain how to narrow the query. An unknown/mismatched cursor returns an actionable error. A single entry too large for the page remains at the cursor: increase `maxChars` or read the reported source instead of accepting a cut symbol. A paginated page is partial even if the underlying query is complete. Backend `limit` truncation is distinct: increase limit/narrow path/query to obtain omitted backend entries.

`read_symbol` still reports source-line condensation/continuation independently. A presentation-truncated source result is not registered as a complete read-before-edit observation.

## Rename is two tools

1. `symbols` with `operation: "rename_preview"` creates a semantic plan; inspect its completeness and files.
2. **Separate tool** `apply_rename` with `{ "planId": "..." }` applies it, with existing hash, workspace, safety and cancellation checks.

`apply_rename` is not a Symbols operation. Signature/argument edits still use normal edit tooling and project type checks; Symbols does not claim an automatic arbitrary signature refactoring engine.

## Verification

From the repository root on Windows with Node/npm on PATH:

```powershell
npm.cmd --prefix packages/coding-agent test -- test/symbols-upgrade.test.ts test/symbols-tool-schema.test.ts test/symbols-tool-phase7.test.ts test/symbols-tool-phase7-final-acceptance.test.ts test/code-intelligence
npm.cmd run build
```

Optional real installed-server tests (read installed modules; temporary projects only):

```powershell
$env:MYHARNESS_SYMBOLS_LSP_E2E = "1"
npm.cmd --prefix packages/coding-agent test -- test/code-intelligence/workflow/workflow-lsp-e2e.test.ts
```

Static checks, fixture tests, real server tests and model-backed A/B campaigns are different evidence. Never infer adoption or token savings from a unit test or direct tool probe. Do not change benchmark tasks/ground truth/scorers to improve the result.
