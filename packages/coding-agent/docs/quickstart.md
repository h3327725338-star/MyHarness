# Quickstart

This page gets you from install to a useful first MyHarness session.

## Install

The current public-ready path is to run MyHarness from a source checkout. The
`@myharness/coding-agent` package is not currently present in the public npm
registry, so the global install command is a future-release example rather
than a currently verified install path.

From the repository root on Windows:

```powershell
npm.cmd install --ignore-scripts
npm.cmd run build
.\dev-web.cmd
```

For a Web source startup check that does not need a Provider credential:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\web-source.ps1 --help
```

After a future npm publication, the intended package installation will be:

```bash
npm install -g --ignore-scripts @myharness/coding-agent
```

`--ignore-scripts` disables dependency lifecycle scripts during install. MyHarness does not require install scripts for normal npm installs.

### Uninstall after an npm publication

After a future npm publication, use the package manager that installed the package. For an npm installation:

```bash
# npm global install
npm uninstall -g @myharness/coding-agent

# pnpm
pnpm remove -g @myharness/coding-agent

# Yarn
yarn global remove @myharness/coding-agent

# Bun
bun uninstall -g @myharness/coding-agent
```

Uninstalling MyHarness leaves global settings, credentials, and installed MyHarness packages in `~/.myharness/agent/`. Sessions remain in each project under `data/workspaces/<workspace-id>/sessions/<session-id>/`.

After a future npm installation, start MyHarness in the project directory you
want it to work on:

```bash
cd /path/to/project
myharness
```

For the current source checkout, run `.\dev-web.cmd` from the repository root
instead; the process still operates on the directory from which you invoke it.

## Configure Provider and authentication

First configure a Provider and model in Settings, `models.json`, or an extension. An environment variable alone does not create a selectable model.

Then provide the credential for that configured Provider before launching MyHarness:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

After a configured model is available, start MyHarness and type a request:

```text
Summarize this repository and tell me how to run its checks.
```

By default, MyHarness gives the model seven built-in tools:

- `read` - read files
- `bash` - run shell commands
- `pwsh` - run PowerShell commands
- `edit` - patch files
- `write` - create or overwrite files
- `symbols` - query source symbols and definitions
- `github` - use the configured GitHub integration

Additional built-in tools (`grep`, `find`, `ls`) are available through tool options. The `agent`, `workflow`, and `ultracode` tools are optional and disabled by default. MyHarness runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give MyHarness project instructions

MyHarness loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

MyHarness loads:

- `~/.myharness/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart MyHarness after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
myharness @README.md "Summarize this"
myharness @src/app.ts @src/app.test.ts "Review these together"
```

Images or text can be pasted with Ctrl+V (Alt+V on Windows); images can also be dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+T to choose a model. Use `/effort` to change the thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models. Ctrl+O toggles transcript details, including the latest thinking block and full tool output.

### Continue later

Sessions are saved automatically:

```bash
myharness -c                  # Continue most recent session
myharness -r                  # Browse previous sessions
myharness --name "my task"    # Set session display name at startup
myharness --session <path|id> # Open a specific session
myharness --session-id <id>   # Open or create the exact project session ID
```

Inside MyHarness, use `/new` to start a new session. Extensions may provide additional session management commands.

### Non-interactive mode

For one-shot prompts:

```bash
myharness -p "Summarize this codebase"
cat README.md | myharness -p "Summarize this text"
myharness -p @screenshot.png "What's in this image?"
myharness -p @report.pdf "Summarize the text, charts, and page layout"
```

Use SDK subscriptions for in-process events. Public terminal print, JSON and RPC modes are removed.

Local `@file` input can preprocess modern Office documents, PDF pages, SVG and design/image formats, and video keyframes. A directory input discovers those supported formats recursively and continues past individual failures. Audio and legacy DOC/XLS/PPT files are not processed.

## Next steps

- [Using MyHarness](usage.md) - browser interaction, slash commands, sessions, context files, and Web startup.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [MyHarness Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md). Browser interaction and lifecycle: [Web UI](web-ui.md).
