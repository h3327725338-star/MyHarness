# Development roadmap and boundaries

[English](DEVELOPMENT_ROADMAP.md) | [简体中文](DEVELOPMENT_ROADMAP.zh-CN.md)

This is a list of candidate development directions drawn from the current source. It is not a schedule, and an item being listed does not mean it is implemented. Before work on any item starts, check the source and tests again; once the source has changed, the new implementation is what counts.

## Current baseline

- The product entry is `packages/coding-agent/src/web.ts` → `src/main.ts`; cross-domain assembly is done by `packages/coding-agent/src/application/resource-loader.ts` and `AgentSession`.
- Agent Core handles only agent state, events, the loop, the tool lifecycle, cancellation and queues. It does not own a Provider catalog, a TUI or Node SQLite.
- The AI package provides the Provider/Models/API/auth contracts, but `providers/all.ts` does not ship an upstream Provider catalog; the application must register or configure Providers.
- The Coding Agent model runtime owns `models.json`, credentials, the model store, and how extension and native Providers are combined.
- Sessions currently use the Coding Agent JSONL storage as the product path. Node SQLite is a separate backend; do not assume the product has switched to it by default.

## Candidate directions

### Provider and model runtime

Goal: keep clear boundaries between `models.json`, extension Providers, credentials, caching and model resolution.

Acceptance criteria: a Provider that is not configured is never presented as available by the docs or the UI; the network, cache, cancel and error states of a refresh are observable; the API implementation, the Provider registration and real requests each have their own test evidence.

Do not rewrite `packages/ai/src/providers/all.ts` into a fake catalog to solve a product-level configuration problem.

### Agent / Session capabilities

Goal: when extending agent events, queues, cancellation, compaction, branches and persistence, keep using the existing Agent/Session contracts.

Acceptance criteria: new state survives persistence, restore, branching and failure; the matching JSONL, migration and (where involved) SQLite tests are updated in the same change; UI special cases are not written into Agent Core.

### Storage backend

Goal: when improving the SQLite backend or adding a new backend, reuse the abstractions in `packages/storage/sqlite-node/src/sqlite/types.ts`.

Acceptance criteria: every schema change comes with an incrementing migration and with tests for transaction rollback, rebuilding the materialized state and recovery after reopening; it is stated clearly whether the product runtime really selects the backend.

### Coding Agent module evolution

Goal: keep the domain boundaries of `agent/runtime`, `session`, `context`, `providers`, `tools`, `extensions`, `git`, `modes` and the other domains.

Acceptance criteria: new logic goes into the existing directory closest to its responsibility; shared capabilities connect through formal API entries or the runtime; `packages/coding-agent/src/utils` does not absorb domain logic; a new run mode has tests for its arguments, lifecycle and output contract.

### Prompts, skills and extensions

Goal: keep fixed system text, composition logic, user resources and extension transforms traceable.

Acceptance criteria: a Prompt change updates the loader/composer docs and the related tests in the same change; evidence that static text takes effect, Project Trust, extension transforms and real Provider requests are kept apart; no "implicit" resource files that do not exist are introduced.

### Tools, Symbols and presentation

Goal: keep the tool execution contract, tool presentation, the symbols backend and the UI layer decoupled.

Acceptance criteria: tool results can be redacted and persisted; symbols results state whether they come from a semantic, LSP or runtime source; plain-text search uses grep/find/ls; the UI layer keeps using Web dialogs and plain-text widgets, does not bring back the terminal component package that was moved out, and has matching Web interaction tests.

## What every later development item must record

1. the affected source directories and public exports;
2. whether configuration, Sessions, migrations, Prompts or package exports changed;
3. the documentation entry points and the result of checking the text against the source;
4. the test commands actually run, and the boundaries not verified;
5. whether it produced `dist` output, lockfile changes, user data or writes to external services.
