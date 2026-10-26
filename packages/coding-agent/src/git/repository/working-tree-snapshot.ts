import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { runGitAsync } from "./integration.ts";

/**
 * Every uncommitted path of the repository (tracked changes and untracked files, not ignored ones) with a hash of
 * its current content ("missing" for a deleted file). Two snapshots tell which files changed in between.
 *
 * @throws {Error} When Git cannot list the working tree.
 */
export async function snapshotWorkingTree(repositoryRoot: string, signal?: AbortSignal): Promise<Map<string, string>> {
	const status = await runGitAsync(
		repositoryRoot,
		["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
		undefined,
		signal,
	);
	if (!status.ok) throw new Error(status.stderr || status.error || "Cannot read the working tree.");
	const snapshot = new Map<string, string>();
	for (const entry of status.stdout.split("\0")) {
		if (entry.length < 4) continue;
		const file = entry.slice(3);
		try {
			snapshot.set(
				file,
				createHash("sha1")
					.update(await readFile(path.join(repositoryRoot, file)))
					.digest("hex"),
			);
		} catch {
			snapshot.set(file, "missing");
		}
	}
	return snapshot;
}
