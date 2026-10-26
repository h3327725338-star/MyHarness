import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
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

/** Answers of `linkedWorktreeAt` per folder; a copy appears or goes away rarely, so a short reuse is plenty. */
const linkedProbes = new Map<string, { linked: boolean; at: number }>();
const LINKED_PROBE_MS = 15_000;

/**
 * Whether `path` lies inside a linked Git worktree anywhere on disk: the nearest `.git` above it is a file pointing
 * into `<repo>/.git/worktrees/` (a submodule's `.git` file points into `.git/modules/` and is not a copy). No Git call.
 */
function linkedWorktreeAt(path: string): boolean {
	const key = resolvePath(path);
	const cached = linkedProbes.get(key);
	if (cached && Date.now() - cached.at < LINKED_PROBE_MS) return cached.linked;
	let linked = false;
	for (let dir = key; ; ) {
		const marker = join(dir, ".git");
		try {
			if (statSync(marker).isFile())
				linked = /^gitdir:.*[\\/]worktrees[\\/][^\\/]+\s*$/m.test(readFileSync(marker, "utf8"));
			break;
		} catch {
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	if (linkedProbes.size > 500) linkedProbes.clear();
	linkedProbes.set(key, { linked, at: Date.now() });
	return linked;
}

/**
 * Whether `path` lies inside a worktree copy: one MyHarness created (`<agentDir>/worktrees/<repo>/<branch>`, a lexical
 * check) or any other linked worktree, such as one made with `git worktree add` in a folder of the user's choosing.
 * The second check reads at most a few `.git` markers and reuses its answer briefly, so every sidebar row can ask.
 */
export function isWorktreeCopyPath(agentDir: string, path: string): boolean {
	if (!path) return false;
	return copyRootParts(agentDir, path) !== undefined || linkedWorktreeAt(path);
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
