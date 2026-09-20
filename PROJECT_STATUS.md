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
- Web Search is optional, disabled by default, and depends on configured
  SearXNG/Crawl4AI-compatible services.
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
- The full Coding Agent suite has two known parallel-sensitive failures in
  `session-pressure-recovery` and `sub-agent`; isolated reruns have passed, but
  the concurrency behavior is not declared fixed.

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
- The source repository is not made public by this cleanup; public history is
  prepared separately from the existing private history. A local one-commit
  `public-release/initial` ref now contains the current source tree; it has not
  been pushed or used to change remote visibility.

## Next project-level work

1. Make and verify the release-asset publication process, including exact
   hashes, sizes, notices and Windows language-server startup.
2. Review the local `public-release/initial` tree with an independent
   privacy/license check (`npm run audit:public`) before changing repository
   visibility or pushing it.
3. Publish a reproducible package or release artifact only after the source
   and runtime paths have their own clean-clone and install evidence.
