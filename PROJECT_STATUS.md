# MyHarness project status

This is a source-based status snapshot for the current checkout. It is not a
promise that every documented integration works on every machine. When a claim
needs a Provider, a credential, an external service, a terminal, or a released
binary, the missing runtime evidence is called out explicitly.

## Current stage

MyHarness is **Early-stage / Work in Progress**. The repository is suitable for
source contributors who can provide a Provider configuration and review the
current contracts. It is not yet a polished, zero-configuration product
release.

## Confirmed in source and targeted tests

- `packages/agent` provides the Provider-independent Agent loop, event stream,
  tool lifecycle, cancellation and session abstractions.
- `packages/ai` provides Provider/API adapters, model types, credentials and
  authentication contracts. The default Provider catalog is intentionally
  empty; users configure `models.json`, Settings or an extension.
- `packages/coding-agent` provides the CLI, Interactive/Print/JSON modes,
  AgentSession, built-in file/shell/symbol/GitHub tools, extensions, skills,
  prompts, Settings, Git integration, sessions and context compaction.
- Workspace records and product sessions use the JSONL/JSON storage under the
  current project `data/workspaces/` tree. SQLite is a separate backend and is
  not the confirmed default Coding Agent storage path.
- The lightweight Symbols index is part of the source tree and does not need a
  language-server download.
- The repository can build and run targeted source CLI smoke tests with a
  synthetic local Provider fixture; that does not prove any external Provider
  or OAuth integration.
- The release/privacy audit is available as `npm run audit:release`, with
  staged and prepared-public-ref variants; the pre-commit and pre-push hooks
  invoke the corresponding checks without printing matched values.

## Experimental or partial

- `agent`, `workflow` and `ultracode` are optional exploration tools. They are
  disabled by default and their child Bash guard is not a security sandbox.
- Web Search is optional and disabled by default. Its default built-in engines are Google and Bing.
  Optional selections include DuckDuckGo, Brave and Brave Search API. Google/Bing use lightweight HTTP first and may
  fall back to a MyHarness-owned Firefox profile when access is blocked; Brave Search API needs a user API key. Real
  CAPTCHA/consent handling may require the user to complete verification in the
  visible Firefox window, while unattended modes return `challenge_required`
  instead of treating the challenge page as a result.
- GitHub tools and OAuth/account integrations require user credentials and
  external network access.
- The SQLite Node backend is maintained and tested as a separate backend; the
  product-level default remains JSONL until the source runtime proves otherwise.
- Bun/binary packaging and real interactive terminal behavior require separate
  machine-level validation beyond TypeScript checks.

## Currently unavailable or not verified

- The heavyweight Windows Code Intelligence archives are not in the source
  checkout. `runtime-manifest.json` has `published: false` and no artifact
  `sizeBytes` or `sha256`, so the installer correctly refuses those downloads.
- Real Windows language-server startup E2E is therefore not claimed. The
  manager, checksum/recovery paths and mock-server tests are available, but a
  published release asset is still required for the real asset path.
- A real Provider-backed first conversation cannot be verified without a user
  supplied Provider/model and credential. No credential is stored in this
  repository.
- A fresh Linux/macOS checkout was not run in this Windows audit.
- The local public-release validation covered the Windows Coding Agent suite and
  the targeted recovery tests. Hosted runner results and path spelling behavior
  remain separate CI evidence; they should not be generalized to all Windows
  machines or to external Provider behavior.

## Deliberately deferred

- Publishing and signing Code Intelligence release assets.
- Choosing and operating a public npm release process.
- Rewriting or deleting the existing private Git history.
- Broad product expansion, automatic Provider catalogs, and a migration of the
  product Session path to SQLite.

## Decisions already made

- MyHarness-owned contributions use Apache-2.0; inherited and third-party
  material keeps its own notices and terms.
- Code Intelligence defaults to a lightweight source index, with heavyweight
  Windows modules installed per language only when a published, checksummed
  manifest is available.
- Runtime modules and Code Intelligence workspace data are kept outside the
  source checkout and outside project Session data.
- The public repository is served from a separate one-commit orphan history;
  the local `main` branch still retains its private history. Public-history
  updates must continue to be audited separately from private development.

## Next project-level work

1. Make and verify the release-asset publication process, including exact
   hashes, sizes, notices and Windows language-server startup.
2. Publish a reproducible package or release artifact only after the source
   and runtime paths have their own clean-clone and install evidence.
3. Continue platform-specific CI and external Provider validation without
   presenting it as a default product guarantee.
