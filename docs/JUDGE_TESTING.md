# Judge testing guide

This document is written for hackathon judges who need to run and evaluate MyHarness without prior context. It describes what to download or build, how to attach a model, and what to look at in five minutes.

## What the project is

MyHarness is a Windows desktop AI workspace with two modes: Coding mode works inside a project directory, General mode handles research, writing and everyday tasks. An Electron shell starts a local-only Web UI (`127.0.0.1`) and a shared backend; the agent reads and writes files, runs shell commands, drives a built-in browser tab, tracks changes, and keeps resumable sessions on disk. Model access goes through configurable Providers. The reference setup for this submission is NVIDIA Nemotron served by Nebius Token Factory.

## Environment

- Windows 10 or Windows 11, x64.
- Either a published desktop build, or Node.js `>=22.19.0` plus Git for Windows for a source build.
- A model Provider. Nebius Token Factory is the one used in the submission; any OpenAI-compatible endpoint works the same way.

## Get a build

1. Check the repository's [Releases](https://github.com/h3327725338-star/MyHarness/releases) page for a MyHarness desktop package. If a package is present, unzip it and keep the whole folder together, then run `MyHarness.exe`. The binary is unsigned, so Windows SmartScreen may ask for confirmation.
2. If no desktop package is published for your review window, build from source:

```powershell
git clone https://github.com/h3327725338-star/MyHarness.git
cd MyHarness
npm.cmd install --ignore-scripts
npm.cmd run build
.\dev-desktop.cmd
```

The desktop build needs no external Node installation at runtime. Optional features (Bash tool, language servers, Web Search) keep their own requirements, listed in [Windows](../packages/coding-agent/docs/windows.md) and [Web Search](../packages/coding-agent/docs/web-search.md).

## Attach a model

MyHarness intentionally ships an empty built-in Provider catalog, so a model must be configured once:

- Fastest path: copy [`packages/coding-agent/docs/examples/nebius-models.json`](../packages/coding-agent/docs/examples/nebius-models.json) to `%USERPROFILE%\.myharness\agent\models.json`, set `NEBIUS_TOKEN_FACTORY_API_KEY` in the environment, then start the app.
- UI path: `/settings` → **Providers** → **添加 Provider** → **创建自定义 Provider** → OpenAI Chat Completions, Base URL `https://api.tokenfactory.nebius.com/v1/`, then add the model IDs.

Full details, including the exact model IDs, context windows and reasoning levels, are in [NVIDIA Nemotron on Nebius Token Factory](../packages/coding-agent/docs/nebius-token-factory.md).

Without your own Nebius credentials the UI still starts, the repository still builds, and every non-model feature still works; only model-backed turns require the key.

## Five-minute test script

1. Start the app and open a project folder (any Git repository, or this one).
2. Select `Nemotron 3 Ultra` in the model selector. The composer should show the model name and a 1.0M context window.
3. Ask: `Read package.json and list the packages/ directories, then summarize the repository structure. Do not modify any files.`
   - Expected: the agent calls file/shell tools itself, the turn header reports elapsed time and operation count, and the answer names version `0.0.3` and the five workspace packages.
4. Open the **改动** panel: the turn's tool operations are listed there, with the same session on disk under `%USERPROFILE%\.myharness\agent\sessions\`.
5. Open `/settings` → **Providers**: the `nebius` Provider shows its Base URL and the Nemotron models you configured, including `Nemotron-3.5-Super-VL` if you added it for image input.
6. Optional, if you have a Tavily key: enable Web Search, run one search, and confirm results come from a real API call rather than a mock.

## What to inspect in the source

- `packages/agent/` — agent loop and harness contracts.
- `packages/ai/` — Provider/API layer, request shaping, streaming.
- `packages/coding-agent/` — product layer: AgentSession, tools, sessions, settings, Web UI server.
- `packages/desktop/` — Electron shell and packaging.
- `.github/workflows/ci.yml` — the two Windows runner jobs that gate every change.

## Known limitations

- Windows desktop only; there is no hosted demo, because the product works on local files.
- The built-in Provider catalog is empty by design; a `models.json` entry is required before any model appears.
- Web Search is off by default and needs a search backend or key.
- Symbols (semantic code navigation) needs optional per-language modules and is disabled by default.
- Sessions, settings and credentials live under `%USERPROFILE%\.myharness\`; nothing is sent anywhere except the model and search endpoints you configure.

## During the judging window

The repository stays public and the license stays in place until judging ends. If a build asset is missing or a link is broken, open an issue on the repository or contact the submitter through Devpost.
