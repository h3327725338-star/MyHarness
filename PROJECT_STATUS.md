# MyHarness project status

This is a status snapshot for the current checkout, from the source and from the
maintainer's real use. It is not a promise that every documented integration
works on every machine. What has not been run is listed under
[Current limits](#current-limits).

## Current stage

MyHarness is **actively developed and usable on Windows x64**. The maintained
paths are the Windows desktop app (Electron plus a loopback-only Web UI) and a
source checkout of the same code. The `@myharness/ai` Provider catalog is empty
by design; the app offers Nebius Token Factory ready-made, so one Token Factory
API key (or another Provider configured by hand) is needed before the first
model-backed session. No credential is stored in this repository.

## Verified in real use

The maintainer uses MyHarness every day and has tested it on at least four
Windows PCs, including PCs set up from the installer. As of October 2026 the
following has been run on them for real, with real accounts and a real Nebius
Token Factory key, and works stably in that use:

- **Install and models.** The Windows installer (NSIS, not code-signed) on a
  fresh PC; the one-key Token Factory setup; DeepSeek V4.1 Flash 1017 as the
  main chat, including tool calls and its thinking levels; NVIDIA Nemotron
  models for sub-agents, naming, translation, background jobs and images.
- **Built-in browser.** The agent works in sites the user is signed into: it
  reads full pages, clicks and types, uses bookmarks and their purpose notes,
  and hands control back at sign-in pages and human checks.
- **Memory.** Global, workspace and session memory saved without being asked, a
  user profile built from it, background tidying, and recall in new chats.
- **Conversations.** Several chats at once, answers that draw on earlier chats,
  long work that continues through compaction, rewind and fork, steering a
  running turn, search, archive and HTML export.
- **Workspaces and prompts.** A workspace for each part of life with its own
  memory, the personal prompt and saved prompts.
- **Sync.** Memory, General-mode chats, scheduled tasks, bookmarks, prompts,
  drafts, workspace files and the built-in browser's data through the user's
  own Google Drive, across those PCs, including merging, folder rename and
  revoked authorization.
- **On its own.** Scheduled tasks with corner cards and desktop notifications,
  running in the tray, starting with Windows and carrying on after the app
  restarts.
- **Search.** Web search with Tavily and Google, and reusing the cookies of
  everyday browser profiles, Chrome and Edge included.
- **Code Intelligence.** Downloading language modules and running their
  language servers.
- **Everyday tools.** Quote and ask, translating a selection with UK/US
  pronunciation, understanding images, sub-agents working in parallel, and the
  Terminal panel.

Measured runs of these workflows on NVIDIA Nemotron, with every failure and its
cause, are in the [evaluation](docs/evaluation/README.md).

## Confirmed in source and targeted tests

- `packages/agent` provides the Provider-independent Agent loop, event stream,
  tool lifecycle, cancellation and session abstractions.
- `packages/ai` provides Provider/API adapters, model types, credentials and
  authentication contracts. The default Provider catalog is intentionally
  empty; users configure `models.json`, Settings or an extension.
- `packages/coding-agent` provides the Web service (`myharness`, loopback-only
  Web UI) and a Node.js SDK for in-process integrations, AgentSession, built-in
  file/shell/symbol/GitHub tools, extensions, skills, prompts, Settings, Git
  integration, sessions and context compaction. Terminal Interactive, Print and
  JSON modes have been removed; the Web Terminal panel is retained.
- Workspace records and product sessions use the JSONL/JSON storage under the
  current project `data/workspaces/` tree. SQLite is a separate backend and is
  not the confirmed default Coding Agent storage path.
- The Symbols capability uses semantic language-server services only. The
  `symbols` tool is disabled by default and controlled by
  `codeIntelligence.symbolsEnabled`; optional Windows modules are managed per
  language. Plain-text search remains available through `grep`, `find` and `ls`.
- Windows Code Intelligence archives are not stored in the source checkout; they
  are downloaded per language from the Release named in `runtime-manifest.json`,
  which provides exact artifact sizes and SHA-256 values.
- The repository can build and run targeted source smoke tests (`--help` against
  the Web entry) with a synthetic local Provider fixture; that does not prove any external Provider
  or OAuth integration.
- The release/privacy audit is available as `npm run audit:release`, with
  staged and prepared-public-ref variants; the pre-commit and pre-push hooks
  invoke the corresponding checks without printing matched values.

## Defaults and optional parts

- Sub-agents (`agent`, `workflow`, `ultracode`, `agent_tasks`) are off in the
  factory settings. The Nebius Token Factory one-key setup, which is the normal
  first-run path, turns them on with Nemotron 3 Ultra unless the user turned
  them off first; with a Provider configured by hand they stay off until the
  user turns them on. Their child Bash guard is not a security sandbox.
- Web Search is on by default with Tavily API and Google. Without a user key Tavily is called through its free
  keyless access (`X-Tavily-Access-Mode: keyless`, rate limited by Tavily); a free key adds 1,000 searches a month.
  Optional selections include Bing, DuckDuckGo and Brave. Google/Bing use lightweight HTTP first and may
  fall back to a MyHarness-owned Firefox profile when access is blocked. Real
  CAPTCHA/consent handling may require the user to complete verification in the
  visible Firefox window, while unattended modes return `challenge_required`
  instead of treating the challenge page as a result.
- GitHub tools and OAuth/account integrations require user credentials and
  external network access.
- The SQLite Node backend is maintained and tested as a separate backend; the
  product-level default remains JSONL until the source runtime proves otherwise.
- Bun/binary packaging requires separate machine-level validation beyond
  TypeScript checks.

## Current limits

- Token Factory's real low-balance error has not been seen, because the
  maintainer's balance has never run out, and how far each thinking level of
  DeepSeek V4.1 Flash 1017 changes the amount of reasoning has not been measured.
  The setup's automated tests run against a local stub endpoint.
- Running out of Google Drive quota has not come up in real use.
- A fresh Linux/macOS checkout was not run in this Windows audit.
- The local public-release validation covered the Windows Coding Agent suite and
  the targeted recovery tests. Hosted runner results and path spelling behavior
  remain separate CI evidence; they should not be generalized to all Windows
  machines or to external Provider behavior.

## Deliberately deferred

- Signing Code Intelligence release assets (the manifest already marks the release as published).
- Choosing and operating a public npm release process.
- Rewriting or deleting the existing private Git history.
- Broad product expansion, automatic Provider catalogs, and a migration of the
  product Session path to SQLite.

## Decisions already made

- MyHarness-owned contributions use Apache-2.0; inherited and third-party
  material keeps its own notices and terms.
- Code Intelligence exposes semantic/LSP navigation only. The Symbols tool is
  opt-in and defaults off; language-server modules remain optional and are
  installed per language using the checked-in runtime manifest.
- Runtime modules and Code Intelligence workspace data are kept outside the
  source checkout and outside project Session data.
- The public repository started from a one-commit orphan history ("MyHarness
  public release candidate", 2026-09-21), so earlier private history is not part
  of it. Development has continued on that history since: the local `main` is
  the same branch as the public `main`, and every push is audited by the
  pre-push hook's full-tree release audit.

## Next project-level work

1. Keep release assets verifiable, with exact hashes, sizes and notices for each
   published installer and Code Intelligence module.
2. Keep each release's source and install paths backed by their own clean-clone
   and install evidence.
3. Continue platform-specific CI and external Provider validation without
   presenting it as a default product guarantee.
