# MyHarness

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: Apache-2.0](https://img.shields.io/github/license/h3327725338-star/MyHarness)](LICENSE)

MyHarness is an early-stage, source-based terminal AI coding assistant for working in a project directory. It connects configured LLM Providers to repository files, shell commands, tools, and resumable sessions.

> Status: Early-stage / Work in Progress. The current maintained and validated path is a Windows x64 source checkout. Configure a Provider, model, and credentials before expecting a real model-backed session.

## Core capabilities

- **Code collaboration**: file, shell, PowerShell, editing, writing, Symbols, Git, and GitHub workflows exposed through the Coding Agent product layer.
- **Entry points**: the terminal UI (Interactive), Print and JSON event stream modes, a local browser **Web UI** (`myharness --web`, loopback only) that shares the same runtime, and a Node.js SDK for in-process integrations.
- **Project context**: project trust, `AGENTS.md` / `CLAUDE.md` context files, Workspace and Session management, Git integration, and context compaction.
- **Extensibility**: TypeScript extensions, skills, prompt templates, themes, custom Providers, and MyHarness packages.
- **Code Intelligence**: a lightweight Symbols index is available from the source tree. Semantic language-server modules remain optional and unavailable until a published, checksummed runtime manifest is provided.
- **Optional workflows**: Explore sub-agents, `/workflow`, `/ultracode`, and Web Search can be enabled by configuration; Web Search requires a compatible external service.

The source and current status documents intentionally distinguish implemented contracts, configured runtime behavior, and machine- or credential-dependent validation. MyHarness does not ship a default Provider/model catalog in this checkout.

## Quick Start (Windows source checkout)

Requirements:

- Node.js `>=22.19.0`;
- Git for Windows if you want to use the `bash` tool on Windows;
- a Provider, model, and the credentials required by that Provider.

```powershell
git clone https://github.com/h3327725338-star/MyHarness.git
cd MyHarness
npm.cmd install --ignore-scripts
npm.cmd run build
.\dev.cmd
```

After startup, configure a Provider and model in `/settings`, then enter a task. Provider configuration is described in [Providers](packages/coding-agent/docs/providers.md) and [Settings](packages/coding-agent/docs/settings.md).

To check that the source CLI can start without a Provider credential:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\myharness-test.ps1 --help
```

This smoke check does not prove that an external Provider, OAuth flow, Web Search service, or real model conversation works.

## Documentation

- [Coding Agent documentation index](packages/coding-agent/docs/index.md)
- [Quickstart](packages/coding-agent/docs/quickstart.md)
- [Usage and CLI reference](packages/coding-agent/docs/usage.md)
- [Providers and models](packages/coding-agent/docs/providers.md)
- [Windows setup](packages/coding-agent/docs/windows.md)
- [Project status and validation boundaries](PROJECT_STATUS.md)
- [Architecture and development handbook](ARCHITECTURE_AND_DEVELOPMENT.md)
- [Development guide](packages/coding-agent/docs/development.md)
- [Source module map](packages/coding-agent/docs/source-modules.md)
- [Storage and data boundaries](docs/STORAGE.md)
- [Maintenance guide](MAINTENANCE.md)
- [GitHub automation](docs/maintenance/github-automation.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Documentation map](DOCUMENTATION_INDEX.md)
- [简体中文 README](README.zh-CN.md)

## Development and contribution

From the repository root:

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run audit:release
```

`npm.cmd run check` runs Biome with write enabled and can modify formatted files. See [CONTRIBUTING.md](CONTRIBUTING.md) for the supported checks, release/privacy boundaries, and pull-request expectations.

## License

MyHarness-owned work is distributed under the [Apache License 2.0](LICENSE). Inherited and third-party components retain their own licenses, copyrights, and attributions; see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
