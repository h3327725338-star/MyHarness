# MyHarness Documentation

[English](index.md) | [简体中文](index.zh-CN.md)

MyHarness is a terminal code-collaboration tool. The Coding Agent product layer provides the CLI, AgentSession, tools, sessions, Provider runtime, project trust, and the extension/resource system.

## Quick start

The repository does not currently publish `@myharness/coding-agent` to the public npm registry. Use a source checkout on Windows:

```powershell
npm.cmd install --ignore-scripts
npm.cmd run build
.\dev.cmd
```

Sign in to the built-in OpenAI ChatGPT Provider, or configure another Provider and model in `models.json`, Settings, or an extension before starting a model-backed session. The library-level `ModelRuntime.create()` catalog remains empty until a product entrypoint or extension registers a Provider. See [Quickstart](quickstart.md) for the first-session flow.

## Start here

- [Quickstart](quickstart.md) — install, configure authentication, and run a first session.
- [Usage](usage.md) — Interactive mode, Slash Commands, context files, and CLI reference.
- [Web UI](web-ui.md) — the local browser UI (`myharness --web`): conversation, diffs, files, terminal, Git, settings, and how it shares the CLI's runtime.
- [Providers](providers.md) — Provider configuration, credentials, and model runtime boundaries.
- [llama.cpp](llama-cpp.md) — run a local router and manage models.
- [Security](security.md) — Project Trust, sandbox boundaries, and vulnerability reporting.
- [Containerization](containerization.md) — isolate MyHarness with Gondolin, Docker, or OpenShell.
- [Settings](settings.md) — global and project settings.
- [Windows](windows.md) — Bash and Windows-specific setup.
- [Web Search](web-search.md) — optional built-in web search (Google/Bing first, with optional DuckDuckGo, Brave, Brave Search API and Firefox fallback) and page reading.
- [Sessions](sessions.md) — Session management, branching, and navigation.
- [Compaction](compaction.md) — context compaction and branch summaries.
- [Git Worktrees](worktrees.md) — managing development worktrees through `/git`.
- [Keybindings](keybindings.md) — default shortcuts and customization.
- [Interaction guidelines](interaction-guidelines.md) — the shared contract for settings, navigation, actions, dialogs, feedback, and keyboard behavior.
- [TUI design system](tui-design-system.md) — shared visual hierarchy, tokens, status projection, and terminal interaction rules.

## Extensibility

- [Extensions](extensions.md) — TypeScript modules for tools, commands, events, and custom UI.
- [Skills](skills.md) — reusable, on-demand Agent Skills.
- [Prompt templates](prompt-templates.md) — reusable prompts exposed through command completion.
- [Themes](themes.md) — built-in and custom terminal themes.
- [MyHarness packages](packages.md) — package extensions, skills, prompts, and themes.
- [Custom models](models.md) — add model entries for a configured Provider API.
- [Custom providers](custom-provider.md) — implement custom APIs and OAuth flows.

## Programmatic use

- [SDK](sdk.md) — embed MyHarness in a Node.js application.
- [JSON event stream mode](json.md) — structured events from print mode.
- [TUI components](tui.md) — build custom terminal UI for extensions.

## Reference and platform setup

- [Session format](session-format.md) — JSONL format, entry types, and SessionManager API.
- [Termux on Android](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## Development

- [Architecture and development handbook](../../../ARCHITECTURE_AND_DEVELOPMENT.md) — current module ownership, dependency boundaries, and verification rules.
- [Agent rules](../../../AGENTS.md) — repository rules for Coding Agent and AI Agent work.
- [Development guide](development.md) — local environment, project structure, and debugging.
- [Source module map](source-modules.md) — current top-level `src` directories and responsibilities.
- [Product maintenance](maintenance.md) — startup assembly, Providers, Sessions, Prompts, tools, and validation rules.
- [Roadmap and boundaries](roadmap.md) — candidate work and acceptance boundaries based on the current source.

### Historical architecture records

The following documents record earlier refactoring phases. They are historical context, not the sole authority for the current architecture; use the root handbook, source, and package configuration for current behavior.

- [Phase 0 architecture baseline](architecture-baseline.md)
- [Phase 1 architecture boundaries](phase1-architecture-boundaries.md)
- [Phase 2 architecture boundaries](phase2-architecture-boundaries.md)
- [Phase 3 architecture boundaries](phase3-architecture-boundaries.md)
