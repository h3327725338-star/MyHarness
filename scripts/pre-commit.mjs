import { existsSync } from "node:fs";
import { runGitSyncChecked } from "./git-command.mjs";

// 说明：`npm run check`（.husky/pre-commit 中先行执行）已经无条件包含
// check:browser-smoke，因此这里不再重复运行 browser-smoke；
// 本脚本只负责把 biome --write 可能修改过的 staged 文件重新暂存。

const stagedFiles = runGitSyncChecked(["diff", "--cached", "--name-only", "-z"]).stdout
	.split("\0")
	.filter(Boolean);

// Re-stage only paths that still exist in the working tree. Staged deletions
// (paths removed from both the index and the disk) cannot be re-added and are
// already recorded as deletions in the index.
const existingFiles = stagedFiles.filter((file) => existsSync(file));
if (existingFiles.length > 0) {
	runGitSyncChecked(["add", "--", ...existingFiles], { stdio: "inherit" });
}
