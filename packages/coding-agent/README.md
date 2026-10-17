# MyHarness Coding Agent

MyHarness is a local browser coding agent. The only user interface is the Web UI; terminal chat, print, JSON output and RPC modes are not available.

## Source startup on Windows

From the repository root:

```powershell
npm.cmd install --ignore-scripts
npm.cmd run build
.\dev-desktop.cmd
```

Daily use goes through the desktop app: double-click `dev-desktop.cmd` in the repository root. To run the sources directly in the caller's working directory, use `node --import ./scripts/dev-fast-loader.mjs ./packages/coding-agent/src/web.ts` (arguments are forwarded). The service never opens a browser; it prints its actual address as `MyHarness Web UI: <url>`. The built `myharness` command starts the same service through `dist/web.js`.

Configure Providers, credentials and models in browser Settings or `models.json`. There is no default Provider catalog. Local runtime data, credentials and existing Session formats are preserved.

## Product capabilities

Browser conversations, multiple Chats and Workspaces, context compaction, tools, Git checkpoints and Worktrees, structured file changes, extensions, Skills and Prompt templates share one AgentSession runtime. The page's Terminal panel provides real independent Shell processes; it is not a terminal Agent frontend.

Extensions use browser dialogs and plain-text presentation. Terminal components, raw terminal input handlers and Tool terminal render callbacks are removed. Legacy persisted Theme and Settings data remain readable for compatibility, but do not restore terminal interaction.

## Documentation

- [Web UI and lifecycle](docs/web-ui.md)
- [Usage](docs/usage.md)
- [Providers](docs/providers.md) and [Models](docs/models.md)
- [Settings](docs/settings.md) and [Security](docs/security.md)
- [Sessions](docs/sessions.md) and [Session format](docs/session-format.md)
- [Extensions](docs/extensions.md), [Skills](docs/skills.md) and [Prompt templates](docs/prompt-templates.md)
- [SDK](docs/sdk.md) for in-process integration
- [Development](docs/development.md) and [Maintenance](docs/maintenance.md)

See the root [README](../../README.md) for source distribution status and the [architecture handbook](../../ARCHITECTURE_AND_DEVELOPMENT.md) for module boundaries.
