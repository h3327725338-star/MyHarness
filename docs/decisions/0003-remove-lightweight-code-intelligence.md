# ADR 0003: Remove lightweight Code Intelligence

- Status: accepted
- Date: 2026-10-11
- Supersedes: [ADR 0002](0002-lightweight-code-intelligence.md)

## Context

Users decided to remove the lightweight Symbols layer and keep semantic/LSP
language-server operations as the only Symbols capability. Plain-text search is
provided by `grep`, `find` and `ls` instead of a code index.

## Decision

Delete the lightweight backend, source index, legacy adapter and their
lexical Symbols operations. Add `codeIntelligence.symbolsEnabled`, defaulting to
`false`; when it is off, the Symbols tool is not registered or exposed to the
model. Language-server modules remain optional and managed per language by the
runtime manifest.

## Consequences

The public API loses the removed lightweight and legacy exports and operations.
The old `<agentDir>/code-index/` cache directory is no longer used and is not
automatically deleted; users may remove it manually. The deprecated
`codeIntelligence.enabled` key is ignored, is not migrated to the new switch,
and is no longer written.
