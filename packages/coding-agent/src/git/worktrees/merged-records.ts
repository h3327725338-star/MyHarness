import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { resolvePath } from "../../utils/paths.ts";
import { worktreeId } from "./display-name.ts";

/** Folders under `<agentDir>/worktrees` that hold MyHarness metadata, never a copy. */
const METADATA_DIRS = new Set(["names", "services", "launchers", "merged", "archive"]);

/** `[repo, branch]` folder names of the copy that contains `path`, or undefined outside every copy. */
function copyRootParts(agentDir: string, path: string): [string, string] | undefined {
	if (!path) return undefined;
	const inside = relative(resolvePath(join(agentDir, "worktrees")), resolvePath(path));
	if (!inside || inside.startsWith("..") || isAbsolute(inside)) return undefined;
	const parts = inside.split(/[\\/]+/).filter((part) => part && part !== ".");
	if (parts.length < 2 || METADATA_DIRS.has(parts[0]!)) return undefined;
	return [parts[0]!, parts[1]!];
}

/**
 * Whether `path` lies inside a worktree copy that MyHarness created (`<agentDir>/worktrees/<repo>/<branch>`).
 * Lexical path check only: no Git call and no filesystem access, so it is cheap enough for every sidebar row.
 */
export function isWorktreeCopyPath(agentDir: string, path: string): boolean {
	return copyRootParts(agentDir, path) !== undefined;
}

export interface WorktreeMergedRecord {
	mergedAt: string;
	/** The branch the copy was merged into. */
	into: string;
	/** The copy's commit that was merged. */
	commit?: string;
}

/**
 * Marks copies whose work was merged back. A merged copy stays on disk as a read-only record of its chats; nothing
 * here changes a branch, directory or Git identity.
 */
export class WorktreeMergedRecords {
	private readonly agentDir: string;
	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	get(path: string): WorktreeMergedRecord | undefined {
		const file = this.file(path);
		if (!existsSync(file)) return undefined;
		try {
			const data = JSON.parse(readFileSync(file, "utf8")) as Partial<WorktreeMergedRecord>;
			return typeof data.mergedAt === "string" && typeof data.into === "string"
				? {
						mergedAt: data.mergedAt,
						into: data.into,
						commit: typeof data.commit === "string" ? data.commit : undefined,
					}
				: undefined;
		} catch {
			return undefined;
		}
	}

	/** Whether `cwd` is (inside) a copy that was merged back. */
	covers(cwd: string): boolean {
		const parts = copyRootParts(this.agentDir, cwd);
		return !!parts && !!this.get(join(this.agentDir, "worktrees", parts[0], parts[1]));
	}

	set(path: string, record: WorktreeMergedRecord): void {
		const file = this.file(path);
		mkdirSync(join(this.agentDir, "worktrees", "merged"), { recursive: true });
		const temporary = `${file}.${randomUUID()}.tmp`;
		writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
		renameSync(temporary, file);
	}

	private file(path: string): string {
		return join(this.agentDir, "worktrees", "merged", `${worktreeId(path)}.json`);
	}
}
