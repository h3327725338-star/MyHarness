/**
 * Session ownership for the stateful shell helpers (background jobs, preserve_state).
 *
 * Both features keep per-session records in process-local maps, so the key must
 * identify the *session*, not the directory: two sessions that open the same
 * working directory must not see (or kill) each other's jobs and must not share
 * preserved cwd/env. The tool execution contract hands every tool the same
 * context object extensions get (`ctx.sessionManager`), which is the only place
 * a Session id is readable from inside a tool. Reading it must never throw: a
 * missing or broken context falls back to the tool's creation cwd, which is the
 * historical (weaker) behavior and still keeps a single session self-consistent.
 */

/** Narrow shape of the execution context we actually need. */
interface SessionScopedContext {
	sessionManager?: { getSessionId?: () => unknown };
}

/** Read the current Session id defensively; undefined when it is not reachable. */
export function readSessionId(ctx: unknown): string | undefined {
	try {
		const sessionManager = (ctx as SessionScopedContext | undefined)?.sessionManager;
		const getSessionId = sessionManager?.getSessionId;
		if (typeof getSessionId !== "function") return undefined;
		const sessionId = getSessionId.call(sessionManager);
		return typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Ownership key for shell state belonging to one session.
 * `prefix` keeps different features apart when they share a map (`bash:`/`pwsh:`).
 */
export function resolveSessionScope(ctx: unknown, cwd: string, prefix = ""): string {
	const sessionId = readSessionId(ctx);
	return sessionId ? `${prefix}session:${sessionId}` : `${prefix}cwd:${cwd}`;
}
