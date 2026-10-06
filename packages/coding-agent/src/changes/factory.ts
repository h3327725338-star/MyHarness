import { createHash } from "node:crypto";
import { join } from "node:path";
import { normalizeWorkspaceRoot } from "../symbols/path-semantics.ts";
import { ChangeStore } from "./change-store.ts";
import { ChangeControl, type ChangeControlOptions } from "./service.ts";

const CHANGE_CONTROL_DIRECTORY = "change-control";

/** A workspace's own change state: changesets, journals, permits. Below the agent directory, never in the project. */
export function changeControlRoot(agentDir: string, workspaceRoot: string): string {
	const key = createHash("sha256")
		.update(normalizeWorkspaceRoot(workspaceRoot).toLowerCase())
		.digest("hex")
		.slice(0, 24);
	return join(agentDir, CHANGE_CONTROL_DIRECTORY, "workspaces", key);
}

/**
 * Lock directories are shared by every workspace of the agent directory: a file has one identity, so two
 * workspaces that overlap (a repository and one of its packages) still exclude each other.
 */
export function changeControlLockRoot(agentDir: string): string {
	return join(agentDir, CHANGE_CONTROL_DIRECTORY, "locks");
}

export function createChangeControl(
	options: Omit<ChangeControlOptions, "store"> & { readonly agentDir: string },
): ChangeControl {
	const { agentDir, ...rest } = options;
	return new ChangeControl({
		...rest,
		workspaceRoot: normalizeWorkspaceRoot(options.workspaceRoot),
		store: new ChangeStore(changeControlRoot(agentDir, options.workspaceRoot), {
			lockRoot: changeControlLockRoot(agentDir),
		}),
	});
}
