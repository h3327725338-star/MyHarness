import { existsSync } from "node:fs";

export interface SessionCwdIssue {
	sessionFile?: string;
	sessionCwd: string;
	fallbackCwd: string;
}

interface SessionCwdSource {
	getCwd(): string;
	getSessionFile(): string | undefined;
}

/** Pure check: a stored session cwd that no longer exists. Never throws, never touches disk beyond `existsSync`.
 *
 * @param sessionManager Read source (`getCwd()` + optional `getSessionFile()`).
 * @param fallbackCwd cwd to continue in when the stored one is gone.
 * @returns Issue descriptor, or `undefined` when there is nothing to report (no file, empty cwd, or cwd exists).
 */
export function getMissingSessionCwdIssue(
	sessionManager: SessionCwdSource,
	fallbackCwd: string,
): SessionCwdIssue | undefined {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		return undefined;
	}

	const sessionCwd = sessionManager.getCwd();
	if (!sessionCwd || existsSync(sessionCwd)) {
		return undefined;
	}

	return {
		sessionFile,
		sessionCwd,
		fallbackCwd,
	};
}

/** One-line user-facing message for a missing session cwd. Pure string formatting, no side effects. */
export function formatMissingSessionCwdError(issue: SessionCwdIssue): string {
	const sessionFile = issue.sessionFile ? `\nSession file: ${issue.sessionFile}` : "";
	return `Stored session working directory does not exist: ${issue.sessionCwd}${sessionFile}\nCurrent working directory: ${issue.fallbackCwd}`;
}

/** Error carrying the cwd issue for callers that must stop resume and ask the user where to continue. */
export class MissingSessionCwdError extends Error {
	readonly issue: SessionCwdIssue;

	constructor(issue: SessionCwdIssue) {
		super(formatMissingSessionCwdError(issue));
		this.name = "MissingSessionCwdError";
		this.issue = issue;
	}
}

/**
 * Throw `MissingSessionCwdError` when the stored session cwd is gone.
 *
 * @param sessionManager Read source; no state is mutated.
 * @param fallbackCwd Reported as the alternative cwd inside the error.
 * @throws {MissingSessionCwdError} Only when `getMissingSessionCwdIssue()` finds an issue.
 */
export function assertSessionCwdExists(sessionManager: SessionCwdSource, fallbackCwd: string): void {
	const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
	if (issue) {
		throw new MissingSessionCwdError(issue);
	}
}
