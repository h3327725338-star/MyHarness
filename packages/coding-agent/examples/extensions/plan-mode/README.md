# Plan Mode Extension

Two-phase planning example with plan extraction and execution progress tracking.

This example is not a read-only mode. Both phases retain the normal `read`, `bash`, `edit`, and `write` tools, plus any active tools not managed by the extension. During Phase 2 only, Bash commands are filtered through the allowlist in `utils.ts`; `edit` and `write` remain available.

## Features

- **Two planning phases**: First restate the request, then investigate and produce a numbered plan
- **Full normal tools**: `read`, `bash`, `edit`, and `write` remain active during both planning phases
- **Phase 2 Bash allowlist**: Non-allowlisted Bash commands are blocked after the understanding phase
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **Progress tracking**: Shows completion status during execution
- **`[DONE:n]` markers**: Marks individual steps complete
- **Session persistence**: Restores plan and execution state when a session resumes

## Usage

1. Load the example with `MyHarness --extension ./examples/extensions/plan-mode`. Add `--plan` to the same command if it should start enabled.
2. Run `/plan` or press `Ctrl+Alt+P` to toggle plan mode.
3. In Phase 1, the agent restates its understanding, lists questions, and waits for confirmation.
4. On the next turn, Phase 2 asks the agent to investigate and output numbered steps under a `Plan:` header.
5. Choose `Execute the plan (track progress)`, `Stay in plan mode`, or `Edit the plan`.
6. During execution, `[DONE:n]` markers update the progress widget.

Example plan:

```text
Plan:
1. First step description
2. Second step description
3. Third step description
```

## Actual permission behavior

### Phase 1: Understanding

- Uses the same normal tool set as the default mode.
- `read`, `bash`, `edit`, and `write` are available.
- The Bash allowlist is not applied.

### Phase 2: Planning

- `read`, `bash`, `edit`, and `write` remain available.
- The `tool_call` hook blocks Bash commands that `isSafeCommand()` does not allow.
- The extension does not block `edit` or `write`, so it does not prevent file changes.

### Execution

- Plan mode is disabled and the previous normal tool set is restored.
- The agent executes steps in order and reports `[DONE:n]` markers.

## Phase 2 Bash allowlist

Examples accepted by `utils.ts` include:

- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory inspection: `ls`, `pwd`, `tree`
- Git reads: `git status`, `git log`, `git diff`, `git show`, `git branch`
- Package information: `npm list`, `npm outdated`, `yarn info`
- System information: `uname`, `whoami`, `date`, `uptime`

Commands outside the allowlist are blocked in Phase 2. The allowlist is a workflow guard, not an operating-system sandbox.
