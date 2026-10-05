# Usage rules
- Use agent only when one investigation stage contains multiple independent directions suitable for parallel work. Prefer workflow or ultracode for multistage investigation, cross-review, or high-risk verification.
- Give each Explore task a distinct investigation scope and require file paths, line numbers, confirmed facts, and open questions.
- Set run_in_background=true when other independent work can run in parallel; you will be notified automatically on completion.
- Use at most 18 tasks and synthesize the results yourself. Verify key findings before acting.
- Do not assign the entire repository or an unbounded topic to one task. Each task needs a clear goal, scope, and stop conditions.
- Agent results include completed or partial status, covered scope, findings, evidence, conflicts, unresolved matters, and stop reason. Prefer these fields; do not repeat the same scan of covered scope.
