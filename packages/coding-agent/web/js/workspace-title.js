// The active Chat's Git status, not the server's launch directory, determines the tab title.
import { useLayoutEffect } from "./ui.js";
import { useStore } from "./store.js";

export function workspaceTitle(gitStatus) {
	if (!gitStatus?.isRepository) return "MyHarness";
	const branch = gitStatus.branch || "detached-HEAD";
	if (!gitStatus.linkedWorktree) return `MyHarness-${branch}`;
	const name = gitStatus.copyName || gitStatus.branch || gitStatus.root?.split(/[\\/]/).pop() || "detached-HEAD";
	return name.startsWith("myharness-") ? name.replace(/^myharness-/, "worktree-") : `worktree-${name}`;
}

export function useWorkspaceTitle() {
	const gitStatus = useStore((s) => s.gitStatus);
	useLayoutEffect(() => {
		document.title = workspaceTitle(gitStatus);
	}, [gitStatus]);
}
