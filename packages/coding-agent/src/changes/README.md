# Controlled changes

`ChangeControl` owns preview, gates, approval, hash-bound permits, apply, status and recovery for a workspace. The product creates one instance per AgentSession and injects it into local edit/write/refactor definitions. SDK factories may inject the same instance using tool options; custom/remote operations are refused when a broker is supplied.

- `changeset.ts`, `patch-plan.ts`, `workspace-edit.ts`: exact after bytes, base hashes and reviewable diffs; initial server resource operations are refused.
- `executor.ts`, `process-lock.ts`, existing file mutation queue: shared locks, journal, durable replacement and precise recovery. Multiple-file atomic visibility is not promised.
- `service.ts`, `approval.ts`: gates and browser confirmation for policy-classified high-risk changes. No UI means required approval is refused.
- `factory.ts`, `change-store.ts`: private agent-directory persistence, shared across sessions/processes of that directory.

`previewWrite` deliberately preserves full-write semantics (UTF-8 content replaces the whole file), while edit and LSP plans preserve original encoding/line endings. Changed base hashes invalidate a plan.

## Unfinished quality enforcement

The code-intelligence runtime supplies a TS/JS structural-reuse gate to each session broker using the same CodeSymbolIndex. It checks actual proposed bytes, including token blocks copied into existing functions, same-file duplicates and duplicates created together in one changeset. It uses a workspace/managed compiler, not a product dev-only compiler. Matching 32-token windows are review candidates, not proof of behavioral equivalence. Unsupported language/compiler/index budgets remain unknown (strict gate refuses unknown; assist allows unknown). Candidate review currently requires reuse/modify; no user-approved exception workflow is implemented. Root/impact plans and product strict configuration are still missing. It does not automatically run project checks or persist verification debt. `committed` means only that the controlled write committed, not `verified`. Shell/custom tools are not isolated by these locks, and external user edits cannot be prevented. Do not enable applyEdit capability or advertise absolute write interception based on this module alone.

Tests live in `test/changes/`, `test/file-mutation-queue-multi.test.ts`, `test/refactor-tool.test.ts` and `test/code-intelligence/real/refactor-rename.real.test.ts`. Real server tests are separate from protocol fixtures.
