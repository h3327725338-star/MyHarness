# Extensions

Extensions are TypeScript modules for tools, commands, lifecycle events and Provider registration. MyHarness exposes browser dialogs and plain-text presentation, not terminal components or terminal input handlers.

## Loading

- Global discovery: `~/.myharness/agent/extensions/`.
- Project discovery: `.myharness/extensions/`, subject to Project Trust.
- Explicit startup input: `--extension <source>` (repeatable).
- Disable discovery: `--no-extensions`.

Use the browser resource reload action or restart the backend after changing extension code. Existing terminal extensions must migrate; terminal render callbacks, component factories, custom terminal editors, overlays and `onTerminalInput` are not supported.

## Public API

Import `ExtensionAPI` and related types from `@myharness/coding-agent`. The package facade and `src/extensions/api-entry.ts` define the public exports; `src/extensions/runtime/types.ts` defines the complete contracts.

```typescript
import type { ExtensionAPI } from "@myharness/coding-agent";

export default function (api: ExtensionAPI) {
  api.registerCommand("hello", {
    description: "Show a browser notification",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Hello from an extension", "info");
    },
  });
}
```

## Host and UI

`ctx.mode` is `"web"` for browser hosts and `"headless"` for SDK/delegated workers. `ctx.hasUI` reports whether the host actually supplied dialogs. Check it before asking for user input; do not infer UI availability from a process having a console.

Browser UI methods include `select`, `confirm`, `input`, `notify`, editor text access, status text and plain-text widgets. Message and entry renderers return strings. Tool output is rendered from structured results by the Web frontend. Legacy persisted Theme resources remain readable for data compatibility; they do not provide terminal rendering or control browser appearance.

## Tools, commands and events

- `registerTool` registers execution contracts with parameters, cancellation, progress and results. It does not accept terminal `renderCall` or `renderResult` callbacks.
- `registerCommand` adds slash commands; use `ctx.waitForIdle()` before operations that require an idle runtime.
- `on` subscribes to resource, Session, Agent, message, model, tool, compaction and request events.
- `sendMessage` / `sendUserMessage` inject messages with the delivery semantics defined by their options.
- `appendEntry`, session names and labels persist extension state in the existing Session format.
- `registerProvider` / `unregisterProvider` extend the model runtime; preserve credential and model ownership when changing registration.
- `exec` runs external commands through the existing process execution contract.

Cancellation, tool permission checks, error reporting, resource disposal and Session replacement must use the existing contracts. A module's long-lived resources should be released on shutdown. Do not introduce a second Agent loop or write Session files directly.

## Session and runtime operations

`ExtensionContext` exposes read-only Session access, model state, abort/idle state, context usage, compaction and shutdown. Command contexts additionally expose Session creation, fork, tree navigation, switching and resource reload. These operations can replace the active Session; do not retain stale Session references after replacement.

Provider credentials must never be logged or stored as ordinary extension messages. Project-local code is subject to Trust. See [Security](security.md), [Custom providers](custom-provider.md), [SDK](sdk.md) and [Session format](session-format.md).

Examples under `examples/extensions/` and the extension tests are executable references. Verify an example's imports and host requirements before reuse; historical terminal examples are not a supported API.
