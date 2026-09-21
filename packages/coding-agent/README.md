# MyHarness

MyHarness is maintained in the [MyHarness repository](https://github.com/h3327725338-star/MyHarness).

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily.

---

MyHarness is a minimal terminal coding harness. Adapt MyHarness to your workflows, not the other way around, without having to fork and modify MyHarness internals. Extend it with TypeScript [Extensions](#extensions), [Skills](#skills), [Prompt Templates](#prompt-templates), and [Themes](#themes). Put your extensions, skills, prompt templates, and themes in [MyHarness Packages](#myharness-packages) and share them with others via npm or git.

MyHarness ships with optional built-in `agent`, `workflow`, and `ultracode` tools for parallel, read-only exploration. `/workflow` runs a staged investigation, while `/ultracode` applies a stricter multi-workflow strategy. All three use the model and thinking level selected under **Sub Agent**.

The CLI supports interactive, print, and JSON event-stream modes. The package also exposes an SDK for embedding MyHarness in your own apps. See [openclaw/openclaw](https://github.com/openclaw/openclaw) for a real-world SDK integration.

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [MyHarness Packages](#myharness-packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)

---

## Quick Start

This checkout is currently the source distribution. The package name is not yet
published in the public npm registry, so clone the repository and use the
Windows source launcher described in the root [README](../../README.md). The
global npm command below is reserved for a future package release.

```bash
npm install -g --ignore-scripts @myharness/coding-agent
```

`--ignore-scripts` disables dependency lifecycle scripts during install. MyHarness does not require install scripts for normal npm installs.

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

The environment variable only supplies credentials. Before prompting, configure a matching Provider and model in Settings, `models.json`, or an extension; MyHarness has no default Provider catalog. Then start `myharness`. By default, MyHarness gives the configured model seven built-in tools: `read`, `bash`, `pwsh`, `edit`, `write`, `symbols`, and `github`. Add capabilities via [skills](#skills), [prompt templates](#prompt-templates), [extensions](#extensions), or [MyHarness packages](#myharness-packages).

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

## Providers & Models

MyHarness does not ship a default Provider catalog. It builds the available tool-capable models from configured `models.json` entries, registered extension/native Providers, credentials and the model store. Configured dynamic catalogs refresh automatically; run `MyHarness update --models` to force an immediate refresh. Authenticate via API key or the Provider's supported auth, then select an available model via `/model` (or Ctrl+T).

**API keys:**
- Configured Provider IDs such as `anthropic`, `openai`, `google` or `openrouter` can use their documented environment variables — see [docs/providers.md](docs/providers.md). An environment variable alone does not create a Provider.

Other services require a compatible custom Provider in `models.json` or an extension; see [docs/providers.md](docs/providers.md) for setup instructions.

**Providers, custom providers & models:** Use **Providers** in `/settings` to configure a known Provider ID or create a custom service. You can also edit `~/.myharness/agent/models.json` for services that speak a supported API (OpenAI, Anthropic, Google). The settings wizard stores one Provider-level key collection shared by all models under that Provider, discovers common `/models` catalogs, adds or edits models, and runs a small connection test. For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive Mode

The interface from top to bottom:

- **Startup header** - Shows loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type; border color indicates thinking level
- **Footer** - Working directory, git branch, session name, cumulative cost (or DeepSeek account balance), context usage, auto-compaction state, provider/model, thinking level, and extension status text. Cost includes assistant responses, usage reported by tools, and summary generation.

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+J) |
| External editor | Ctrl+G opens `externalEditor`, `$VISUAL`, `$EDITOR`, Notepad on Windows, or `nano` elsewhere |
| Clipboard | Ctrl+V to paste an image or text (Alt+V on Windows), or drag images onto terminal |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger command completion. [Extensions](#extensions), installed [skills](#skills), and loaded [prompt templates](#prompt-templates) can add entries to this list.

Built-in commands:

| Command | Description |
|---------|-------------|
| `/settings` | Open settings menu |
| `/setting` | Alias for `/settings` |
| `/model` | Switch models |
| `/new` | Start a new session |
| `/workspace` | Open the Workspace / Chat management sidebar |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/effort` | Cycle thinking/effort level |
| `/commit` | Commit the current workspace's local Git changes |
| `/workflow <task>` | Run a multi-agent workflow |
| `/ultracode <task>` | Handle a complex task with stricter investigation |

The task may be written on the same line or after a newline. For example:

```text
/workflow
检查登录系统的实现、配置和测试
```

Other commands can be provided by extensions.

### Keyboard Shortcuts

Customize via `~/.myharness/agent/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Ctrl+D | Exit (when editor empty) |
| Escape | Cancel/abort |
| Ctrl+T | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Ctrl+O | Toggle transcript details (latest thinking block and full tool output) |

By default, thinking is shown as a compact `· Thinking...`/`· Thought for Ns` status and its content is hidden. Tool calls use status-colored `●`/`⏺` lines with an indented `⎿` result summary, including `Waiting…`, `Running…`, success, and failure states. Ctrl+O expands the latest thinking block as `∴ Thinking…` and restores complete tool output, diffs, and extension renderers. Older thinking blocks remain collapsed.

Use `/effort` to change the thinking level. It has no default keyboard shortcut.

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Escape** aborts and restores queued messages to editor
- **Alt+Up** retrieves queued messages back to editor

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so MyHarness can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"`) for providers that support multiple transports.

---

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session-format.md](docs/session-format.md) for file format.

### Management

By default, Sessions auto-save below the project data root. Each Workspace has a stable ID and each Session has its own data directory:
`data/workspaces/<workspace-id>/sessions/<session-id>/conversation/<timestamp>_<session-id>.jsonl`.
Workspace metadata is kept under `data/workspaces/`; `data/` is runtime user data and is ignored by Git.

```bash
myharness -c                  # Continue most recent session
myharness -r                  # Browse and select from past sessions
myharness --no-session        # Ephemeral mode (don't save)
myharness --name "my task"    # Set session display name at startup
myharness --session <path|id> # Use specific session file or ID
myharness --session-id <id>   # Open or create the exact project session ID
myharness --fork <path|id>    # Fork specific session file or ID into a new session
```

`--session` accepts a path or partial ID and requires a match; the session ID is shown when exiting (`To resume this session: MyHarness --session <id>`). `--session-id` uses an exact project-local ID, creating a session with that ID when no match exists; it cannot be combined with `--session`, `--continue`, or `--resume`.

### Branching

Sessions are stored as trees. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. Extensions may provide tree navigation to browse and switch between branches.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy. The full history remains in the JSONL file. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

---

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `~/.myharness/agent/settings.json` | Global (all projects) |
| `.myharness/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

`/settings` provides one **Providers** entry for configured, extension/native and custom services. Enabled and saved-but-disabled Providers are listed separately. Each Provider screen manages one Provider-level API Key collection, its models, and its enabled state. The selected current key is shared by every model under that Provider, including Vision Assistant models; MyHarness never rotates keys automatically. Keys are stored in `~/.myharness/agent/auth.json`. Existing keys in the legacy `vision-auth.json` file are merged into this collection on startup. See [settings](docs/settings.md#providers-api-keys-and-default-model).

The optional **Git** setting creates and uses local version history for the current project. Repository initialization, the first baseline, and each task commit require user confirmation. MyHarness does not configure a remote or upload commits.

### Project Trust

On interactive startup, MyHarness asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.myharness/agent/trust.json`. Trusting a project allows MyHarness to load `.myharness/settings.json` and `.myharness` resources, install missing project packages, and execute project extensions.

Before the trust decision, MyHarness loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted. This split also applies when switching to a session from a different cwd whose trust has not been resolved in the current process.

Non-interactive modes (`-p` and `--mode json`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.myharness/agent/settings.json`, or change it with `/settings`.

`MyHarness config` and package commands use the same project trust flow, except `MyHarness update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Interactive startup is the built-in UI for saving a trust decision for the current project. Saved decisions are written to `~/.myharness/agent/trust.json`. `/settings` only changes the global `defaultProjectTrust` fallback for projects without a saved decision; it does not add or remove current-project entries in `trust.json`.

### Telemetry and update checks

MyHarness has one startup feature:

- **Install/update telemetry:** no endpoint is configured by default. Set `MYHARNESS_INSTALL_TELEMETRY_URL` only when using a trusted compatible endpoint. This setting also controls optional provider attribution headers for OpenRouter, Cloudflare, and direct NVIDIA NIM requests. Opt out by setting `enableInstallTelemetry` to `false` in `settings.json`, or by setting `MYHARNESS_TELEMETRY=0`.

Use `--offline` or `MYHARNESS_OFFLINE=1` to disable all startup network operations described here, including package update checks and install/update telemetry.

---

## Context Files

MyHarness loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.myharness/agent/AGENTS.md` (global)
- Parent directories (walking up from cwd) and the current directory; files enter the prompt from the outermost ancestor to cwd
- In each directory, `AGENTS.md` / case variant wins over `CLAUDE.md` / case variant

Use these files for project instructions (`AGENTS.md`/`CLAUDE.md`), conventions, and common commands. The repository root `AGENTS.md` is also the development-rule entry point for agents working on this MyHarness checkout; it is not a second `system-prompts/` resource tree.

Disable context file loading with `--no-context-files` (or `-nc`).

### System Prompt

When the project is trusted, `.myharness/SYSTEM.md` takes precedence over
`~/.myharness/agent/SYSTEM.md`; when it is not trusted, the global file is used.
The selected `SYSTEM.md` replaces the custom system-prompt input rather than being
merged with both files. `APPEND_SYSTEM.md` follows the same project-over-global
selection and is appended separately. These files are loaded by the Coding Agent
resource loader, not from the repository-owned `system-prompts/` tree.

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files, available through command completion after they are loaded.

```markdown
<!-- ~/.myharness/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: $@
```

Place in `~/.myharness/agent/prompts/`, `.myharness/prompts/`, or a [MyHarness package](#myharness-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke an installed skill through command completion or let the agent load it automatically.

```markdown
<!-- ~/.myharness/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Place in `~/.myharness/agent/skills/`, `~/.agents/skills/`, `.myharness/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [MyHarness package](#myharness-packages) to share with others. See [docs/skills.md](docs/skills.md).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend MyHarness with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

The default export can also be `async`. MyHarness waits for async extension factories before startup continues, which is useful for one-time initialization such as fetching remote model lists before calling `pi.registerProvider()`.

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Sub-agents and plan mode
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and explicit local commits
- SSH and sandbox execution
- MCP server integration
- Make MyHarness look like Claude Code
- Games while waiting (yes, Doom runs)
- ...anything you can dream up

Place in `~/.myharness/agent/extensions/`, `.myharness/extensions/`, or a [MyHarness package](#myharness-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and MyHarness immediately applies changes.

Place in `~/.myharness/agent/themes/`, `.myharness/themes/`, or a [MyHarness package](#myharness-packages) to share with others. See [docs/themes.md](docs/themes.md).

### MyHarness Packages

Bundle and share extensions, skills, prompts, and themes via npm or git. Find packages on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package) or [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628).

> **Security:** MyHarness packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
myharness install npm:@foo/myharness-tools
myharness install npm:@foo/myharness-tools@1.2.3      # pinned version
myharness install git:github.com/user/repo
myharness install git:github.com/user/repo@v1  # tag or commit
myharness install git:git@github.com:user/repo
myharness install git:git@github.com:user/repo@v1  # tag or commit
myharness install https://github.com/user/repo
myharness install https://github.com/user/repo@v1      # tag or commit
myharness install ssh://git@github.com/user/repo
myharness install ssh://git@github.com/user/repo@v1    # tag or commit
myharness remove npm:@foo/myharness-tools
myharness uninstall npm:@foo/myharness-tools          # alias for remove
myharness list
myharness update                               # update installed packages
myharness update --all                         # update all installed packages (alias for --extensions)
myharness update --extensions                  # update installed packages only
myharness update --models                      # refresh model catalogs only
myharness update npm:@foo/myharness-tools             # update one package
myharness config [-l]                            # edit settings (-l for project overrides)
```

Packages install to `~/.myharness/agent/git/` (git) or `~/.myharness/agent/npm/` (npm). Use `-l` for project-local installs (`.myharness/git/`, `.myharness/npm/`). Git `@ref` values are pinned tags or commits; pinned npm versions are skipped by `MyHarness update --extensions` and `MyHarness update --all`, while pinned git refs are reconciled to the configured ref, so use `MyHarness install git:host/user/repo@new-ref` to move an existing package to a new ref. Git packages install dependencies with `npm install --omit=dev` by default, so runtime deps must be listed under `dependencies`; when `npmCommand` is configured, git packages use plain `install` for compatibility with wrappers. If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding a `MyHarness` key to `package.json`:

```json
{
  "name": "my-package",
  "keywords": ["myharness-package"],
  "myharness": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `MyHarness` manifest, MyHarness auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@myharness/coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

await session.prompt("What files are in the current directory?");
```

For advanced multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

---

## Philosophy

MyHarness is aggressively extensible so it doesn't have to dictate your workflow. Features that other tools bake in can be built with [extensions](#extensions), [skills](#skills), or installed from third-party [MyHarness packages](#myharness-packages). This keeps the core minimal while letting you shape MyHarness to fit how you work.

**No MCP.** Build CLI tools with READMEs (see [Skills](#skills)), or build an extension that adds MCP support.

**Optional exploration sub-agents and workflows.** The built-in `agent` tool can run up to 18 exploration tasks. The `workflow` tool runs one or more sequential phases with multiple parallel Explore tasks per phase and forwards each phase's findings to the next phase. Both are disabled by default; enable and configure them under **Sub Agent** in `/settings`. Children cannot edit files or create child agents. For other orchestration styles, build an [extension](#extensions), install a package, or run separate MyHarness instances with tmux.

**Optional long-term memory.** Auto Memory is disabled by default. Enable it under **Auto Memory** in `/settings` and choose a model plus thinking level. After any enabled Auto Review completes, MyHarness makes one tool-free extraction request and waits for it before publishing the final response. It saves durable preferences, corrections, and already-verified project facts, then recalls relevant notes before future requests. Saved memories are low-priority context and cannot override current instructions. See [settings](docs/settings.md#automemory) for storage, privacy, and limits.

**Optional dedicated vision model.** Vision Assistant is disabled by default. Enable it under **Vision Assistant** in `/settings` to use a configured image-capable model as the main model's eyes. For PDF and modern Office documents, MyHarness preserves the complete extracted text separately, keeps stable page/slide/worksheet labels, processes each document independently in resumable batches, and stores the visual transcription for the main model to read. Large collections run as persistent background jobs; incomplete pages produce a partial result instead of a false success. The vision model extracts visible content; the main model remains responsible for interpretation and conclusions. The vision request has no tools, and full reports are collapsed behind Ctrl+O. **Block images** overrides it and prevents all model-bound image transfer. See [settings](docs/settings.md#visionassistant) for supported image types and privacy behavior.

**No permission popups.** Run in a container, or build your own confirmation flow with [extensions](#extensions) inline with your environment and security requirements.

**No plan mode.** Write plans to files, or build it with [extensions](#extensions), or install a package.

**No built-in to-dos.** They confuse models. Use a TODO.md file, or build your own with [extensions](#extensions).

**No background bash.** Use tmux. Full observability, direct interaction.

---

## CLI Reference

```bash
myharness [options] [@files...] [messages...]
```

### Package Commands

```bash
myharness install <source> [-l]     # Install package, -l for project-local
myharness remove <source> [-l]      # Remove package
myharness uninstall <source> [-l]   # Alias for remove
myharness update [source]           # Update one package source
myharness update --all              # Update all installed packages (alias for --extensions)
myharness update --extensions       # Update installed packages only
myharness update --models           # Refresh model catalogs only
myharness update --extension <src>  # Update one package
myharness list                      # List installed packages
myharness config [-l]               # Edit settings (-l for project overrides)
```

`MyHarness config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `MyHarness update` never prompts for project trust.

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode text` | Text output; interactive on a TTY and print mode otherwise |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--export <file>` | Export session to HTML |

`--mode rpc` is not a valid value in the current CLI. Use the SDK for in-process integration or `--mode json` for a structured event stream.

In print mode, MyHarness also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | myharness -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (e.g., `anthropic`, or a custom provider) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |
| `--context-window <size>` | Override the context window (for example, `256K`) |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume` | Browse and select session |
| `--session <path\|id>` | Use specific session file or partial UUID |
| `--session-id <id>` | Use an exact project session ID, creating it if missing |
| `--fork <path\|id>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |
| `--name <name>`, `-n <name>` | Set session display name at startup |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific tool names across built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific tool names across built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools by default but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools by default |

Available built-in tools: `read`, `bash`, `pwsh`, `edit`, `write`, `grep`, `find`, `ls`, `symbols`, `agent`, `workflow`, `ultracode`, and `github`. The default set is `read`, `bash`, `pwsh`, `edit`, `write`, `symbols`, and `github`; `grep`, `find`, and `ls` are opt-in, while `agent`, `workflow`, and `ultracode` are configured under **Sub Agent** in `/settings`. Their child processes have no `edit` or `write` tool, but their Bash guard is a blacklist of common mutating commands rather than a security sandbox; do not treat it as strictly read-only.

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions`, `-ne` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills`, `-ns` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates`, `-np` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable AGENTS.md and CLAUDE.md context file discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Append custom instructions to the default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup (overrides quietStartup setting) |
| `--offline` | Disable startup network operations (equivalent to `MYHARNESS_OFFLINE=1`) |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

```bash
myharness @prompt.md "Answer this"
myharness -p @screenshot.png "What's in this image?"
myharness @code.ts @test.ts "Review these files"
myharness -p @report.pdf "Summarize the text, charts, and page layout"
myharness -p @demo.mp4 "Describe the visible workflow"
```

Local file preprocessing also supports modern Office documents, complete page-level PDF corpora, SVG and design/image conversion, and video keyframes. A directory passed as an `@` argument is scanned recursively for supported documents, images, design files, and videos; one failed item does not stop the rest. Audio and legacy DOC/XLS/PPT files remain unsupported. See [Vision Assistant settings](docs/settings.md#visionassistant) for the exact formats and limits.

### Examples

The model names below are examples only. The current MyHarness tree has no default Provider catalog; configure the Provider/model in Settings, `models.json`, or an extension before using them.

```bash
# Interactive with initial prompt
myharness "List all .ts files in src/"

# Non-interactive
myharness -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | myharness -p "Summarize this text"

# Named one-shot session
myharness --name "release audit" -p "Audit this repository"

# Different configured model
myharness --provider anthropic --model claude-opus-4-6 "Help me refactor"

# Model with provider prefix (no --provider needed)
myharness --model anthropic/claude-opus-4-6 "Help me refactor"

# Model with thinking level shorthand
myharness --model claude-opus-4-6:high "Solve this complex problem"

# Limit model cycling
myharness --models "claude-*"

# Read-only mode
myharness --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
myharness --exclude-tools ask_question

# High thinking level
myharness --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `MYHARNESS_CODING_AGENT_DIR` | Override config directory (default: `~/.myharness/agent`) |
| `MYHARNESS_CODING_AGENT_SESSION_DIR` | Override session storage directory (overridden by `--session-dir`) |
| `MYHARNESS_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `MYHARNESS_OFFLINE` | Disable startup network operations, including package update checks and install/update telemetry |
| `MYHARNESS_TELEMETRY` | Override install/update telemetry and provider attribution headers. Use `1`/`true`/`yes` to enable or `0`/`false`/`no` to disable |
| `MYHARNESS_INSTALL_TELEMETRY_URL` | Optional base URL for a trusted compatible install/update telemetry endpoint; unset by default |
| `MYHARNESS_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `VISUAL`, `EDITOR` | Fallback external editor for Ctrl+G when `externalEditor` is unset; defaults to Notepad on Windows and `nano` elsewhere |

---

## Contributing & Development

See [docs/development.md](docs/development.md) for setup, forking, and debugging.
See [the architecture and development manual](../../ARCHITECTURE_AND_DEVELOPMENT.md) for current module ownership, dependency boundaries, and validation guidance. Agent-specific hard rules are in [../../AGENTS.md](../../AGENTS.md).

## License

Apache-2.0. See [the repository license](../../LICENSE) and
[third-party notices](../../THIRD_PARTY_NOTICES.md). Inherited and third-party
source keeps its own notices and license terms.

## See Also

- [@myharness/ai](../ai/README.md): Core LLM toolkit in this checkout
- [@myharness/agent-core](../agent/README.md): Agent framework in this checkout
- [@myharness/tui](../tui/README.md): Terminal UI components in this checkout

The package names above are workspace package names; they are not currently
available from the public npm registry.
