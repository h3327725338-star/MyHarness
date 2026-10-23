/**
 * The Web UI preferences file, `<agentDir>/web-ui-prefs.json`: `{ prefs, updatedAt }`, where the page owns the contents
 * and `updatedAt` is the time of the last change. The Web routes serve and store it; Google Drive sync reads and writes
 * the one part of it that travels between devices (the user's saved prompts).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomicallySync } from "../utils/atomic-write.ts";

export const WEB_PREFS_FILE = "web-ui-prefs.json";

export interface StoredWebPrefs {
	prefs: Record<string, unknown>;
	updatedAt: number;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The stored preferences, or null when there are none yet or the file cannot be read. */
export function readWebPrefs(agentDir: string): StoredWebPrefs | null {
	const file = join(agentDir, WEB_PREFS_FILE);
	if (!existsSync(file)) return null;
	try {
		const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (!isRecord(data) || !isRecord(data.prefs) || typeof data.updatedAt !== "number") return null;
		return { prefs: data.prefs, updatedAt: data.updatedAt };
	} catch {
		return null;
	}
}

export function writeWebPrefs(agentDir: string, value: StoredWebPrefs): void {
	const file = join(agentDir, WEB_PREFS_FILE);
	mkdirSync(dirname(file), { recursive: true });
	writeFileAtomicallySync(file, `${JSON.stringify(value, null, "\t")}\n`);
}
