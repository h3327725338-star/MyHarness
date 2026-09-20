# Phase 3 architecture boundaries

Phase 3 keeps the two large coordinators in place while narrowing their responsibilities:

- `AgentSession` coordinates lifecycle calls and delegates context budget, provider recovery, Git checkpoints, and runtime traces to focused core coordinators.
- `InteractiveMode` remains the input and presentation shell. The Git commit workflow, provider enable/disable rules, and workspace/session deletion/creation flows live under `src/application/use-cases/`.
- Application use cases return workflow results or errors and do not import TUI components, themes, or `InteractiveMode`.
- HTML export keeps its public `AgentSession.exportToHtml()` method, but the theme/tool-renderer adapter is isolated in `exports/html/session-export.ts`.

The existing `AgentSessionRuntime` remains the owner of complete session replacement and workspace relocation. Phase 3 does not move the large `core/` tree or change persistence, UI semantics, or public APIs.
