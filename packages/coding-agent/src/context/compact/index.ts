/**
 * Compaction and summarization pure utilities (no session lifecycle).
 *
 * Intent: stateless branch preparation, summarization, and conversation serialization.
 * Boundary: this entry re-exports only `branch-summarization.ts`, `compaction.ts`, and
 * `utils.ts`. Session-lifecycle coordination (`session-compaction.ts`, `tree-navigation.ts`,
 * `../coordinator.ts`) is owned by `AgentSession` and imported directly, never through here.
 * Contract: callers pass branch entries + settings and get back a preparation/result;
 * persistence, extension veto, credentials, and event emission stay with the host.
 */

export * from "./branch-summarization.ts";
export * from "./compaction.ts";
export * from "./utils.ts";
