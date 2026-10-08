# Usage rules
- Use agent only when one investigation stage contains multiple independent directions suitable for parallel work. Prefer workflow or ultracode for multistage investigation, cross-review, or high-risk verification.
- Give each Explore task a distinct investigation scope and require file paths, line numbers, confirmed facts, and open questions.
- Put the concrete questions in `questions`: the sub-agent must answer them item by item and end its report with a "## Completion checklist" section. A report without that checklist comes back as `partial` (`stopReason: incomplete_answer`) with the unanswered items listed.
- Set run_in_background=true when other independent work can run in parallel; you will be notified automatically on completion.
- Use at most {{maxTasks}} tasks and synthesize the results yourself. Verify key findings before acting.
- Do not assign the entire repository or an unbounded topic to one task. Each task needs a clear goal, scope, and stop conditions.
- Agent results include completed or partial status, covered scope, findings, evidence, conflicts, unresolved matters, and stop reason. Prefer these fields; do not repeat the same scan of covered scope.
- A sub-agent is only stopped early by a real loss of progress (stall watchdog), the wall-clock limit, the turn cap, or cancellation. Repeated steps, failing tool calls and idle turns send it a convergence reminder instead, so a task that keeps running is expected behaviour, not a hang.
