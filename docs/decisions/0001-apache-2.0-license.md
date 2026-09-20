# ADR 0001: Use Apache-2.0 for MyHarness-owned work

- Status: accepted
- Date: 2026-09-20

## Context

The repository contains MyHarness contributions together with inherited source,
adapted code and third-party dependencies. The project needs one clear license
for the work that MyHarness contributors are authorized to license without
erasing the notices that belong to other authors.

## Decision

MyHarness-owned work is distributed under Apache-2.0. The SPDX identifier in
the root and MyHarness package metadata is `Apache-2.0`. The repository keeps a
root `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md`.

Third-party and inherited material remains under its original license. Its
copyright, attribution, NOTICE and source-specific terms remain in the source
file, component notice directory or release package as applicable.

## Reason

This separates the product's current license from upstream provenance and
provides explicit copyright and patent terms for new contributions while
keeping redistribution obligations visible.

## Alternatives considered

- Keeping the historical MIT project metadata: rejected because the project
  owner explicitly selected Apache-2.0 for MyHarness.
- Replacing every MIT/Apache/EPL/BSD string in the repository: rejected because
  those strings often describe third-party or inherited material.
- Applying a single license to all dependencies: rejected because MyHarness
  cannot change licenses it does not own.

## Consequences

Package metadata, README sections and release notices must remain synchronized.
Dependency license fields in lockfiles remain mixed by design. New copied code
must carry the original notice and be listed in the appropriate third-party
notice record.
