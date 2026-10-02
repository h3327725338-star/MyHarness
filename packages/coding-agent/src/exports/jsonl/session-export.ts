import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionManager } from "../../session/manager/index.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "../../session/types.ts";
import { resolvePath } from "../../utils/paths.ts";

/**
 * Export the current session branch to a JSONL file.
 * Writes the session header followed by all entries on the current branch path.
 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
 * @returns The resolved output file path.
 */
export function exportSessionBranchToJsonl(sessionManager: SessionManager, outputPath?: string): string {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp: new Date().toISOString(),
		cwd: sessionManager.getCwd(),
	};

	const branchEntries = sessionManager.getBranch();
	const lines = [JSON.stringify(header)];

	// Re-chain parentIds to form a linear sequence
	let prevId: string | null = null;
	for (const entry of branchEntries) {
		const linear = { ...entry, parentId: prevId };
		lines.push(JSON.stringify(linear));
		prevId = entry.id;
	}

	writeFileSync(filePath, `${lines.join("\n")}\n`);
	return filePath;
}
