# Contributing to MyHarness

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

MyHarness is maintained in the repository at
<https://github.com/h3327725338-star/MyHarness>. Please keep changes focused,
preserve existing user data and configuration formats, and explain any
behavioral or compatibility change in the pull request.

The project is Early-stage / Work in Progress. Read
`ARCHITECTURE_AND_DEVELOPMENT.md`, `PROJECT_STATUS.md` and the relevant package
maintenance guide before changing a public contract. Long-lived design choices
are recorded in `docs/decisions/`.

## Local checls



For a fresh public checkout, start with:

```text
git clone https://github.com/h3327725338-star/MyHarness.git
cd MyHarness
```

The project is Early-stage / Work in Progress. Node.js `>=22.19.0` and Git
Bash on Windows are the current maintenance-environment prerequisites.

From the repository root:

```text
npm install
npm test
npm run check
npm run audit:release
```

`npm run check` includes formatters and checks that may write build or cache
artifacts. Run the narrower package test or TypeScript command when a read-only
check is required, and report exactly what was run.

Windows-only Code Intelligence modules are not committed to the repository.
Changes to `packages/coding-agent/code-intelligence/runtime-manifest.json` must
include a release artifact with an exact byte size and SHA-256 value. Do not
commit language-server archives, credentials, Session data, or generated
runtime directories.

Before opening a PR or pushing a release candidate, run `npm run audit:release`.
For the prepared public history, run `npm run audit:public`. The Git hooks run
the staged/ref variants automatically, but the audit is still a review aid, not
a substitute for checking new fixtures, attribution and external release assets.

MyHarness-owned contributions are licensed under Apache-2.0. Do not replace a
third-party or inherited license with Apache-2.0: retain the original notice,
copyright and attribution, and update `THIRD_PARTY_NOTICES.md` when a copied or
redistributed component changes.

## Pull requests

Describe the affected package, the tests that ran, and any checks that could
not run because they require a real external Provider, a published release, or
machine-specific Windows tooling. Keep unrelated worktree changes intact and
do not force-push shared history. Do not include `data/`, `.myharness/agent/`,
`dist/`, credentials, logs, downloaded Code Intelligence modules or local
absolute paths.
