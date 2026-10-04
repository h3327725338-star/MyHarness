import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathIdentityKey } from "../../utils/paths.ts";

export function worktreeId(path: string): string {
	return createHash("sha256").update(pathIdentityKey(path)).digest("hex").slice(0, 24);
}

/** Display metadata only: never changes a branch, directory or Git identity. */
export class WorktreeDisplayNames {
	private readonly agentDir: string;
	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	get(path: string): string | undefined {
		const file = this.file(path);
		if (!existsSync(file)) return undefined;
		const data = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown };
		return typeof data.name === "string" ? data.name : undefined;
	}

	label(worktree: { path: string; branch?: string }): string {
		return this.get(worktree.path) ?? worktree.branch ?? basename(worktree.path);
	}

	set(path: string, value: string): string {
		const name = value
			.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
			.replace(/\s+/gu, " ")
			.trim();
		if (!name || Array.from(name).length > 80) throw new Error("Copy name must contain 1–80 characters.");
		const file = this.file(path);
		mkdirSync(join(this.agentDir, "worktrees", "names"), { recursive: true });
		const temporary = `${file}.${randomUUID()}.tmp`;
		writeFileSync(temporary, JSON.stringify({ name }), { encoding: "utf8", flag: "wx" });
		renameSync(temporary, file);
		return name;
	}

	private file(path: string): string {
		return join(this.agentDir, "worktrees", "names", `${worktreeId(path)}.json`);
	}
}
