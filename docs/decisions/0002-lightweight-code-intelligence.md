# ADR 0002: Keep Code Intelligence lightweight by default

- Status: accepted, release assets built and awaiting upload
- Date: 2026-09-20

## Context

The previous checkout tracked a very large Windows language-server runtime.
That made the source repository and its history unsuitable for a first public
release. The lightweight Symbols index is useful without native servers, while
semantic language servers have different licenses, prerequisites and update
cadences.

## Decision

The source distribution keeps the lightweight index, installer, launcher,
manifest and redistribution notices. Heavy language modules are optional,
Windows x64-specific and installed per language under the user Agent directory:

`%USERPROFILE%\\.myharness\\agent\\code-intelligence\\`

The installer requires a published manifest entry with an exact archive size,
SHA-256 and compatible MyHarness version range. It uses staging and recovery,
retains shared dependencies while referenced, and never downloads a module at
normal startup. Workspace data for semantic services is separate from project
Session data.

## Reason

This keeps a clone and default startup small, makes the optional cost visible,
and lets each language module carry its own license and prerequisite record.

## Alternatives considered

- Keep the complete runtime in Git: rejected because of repository size and
  history pollution.
- Download an unverified runtime on first startup: rejected because it is not
  reproducible and would hide a large network/write operation.
- Put semantic workspace data in project `data/`: rejected because it mixes
  regenerable index state with user Session data.

## Consequences

Semantic module installation is available only when the manifest reports
`published: true` and every archive carries its exact size and SHA-256. The
archives are built by `scripts/build-code-intelligence-artifacts.mjs` from the
upstream releases and must be uploaded to the GitHub Release named by
`releaseTag`; until they are, a download fails with HTTP 404 rather than
installing anything. Lightweight symbol queries remain the default path. A
future release must update the manifest only after independently verifying the
asset, license records, Windows startup and repair/update behavior.
