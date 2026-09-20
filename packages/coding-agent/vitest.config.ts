import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const aiSrcProviders = fileURLToPath(new URL("../ai/src/providers", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));
// Keep Windows process/filesystem-heavy tests parallel without saturating the
// host's process table and filesystem with the default worker count.
const maxWindowsWorkers = Math.min(8, availableParallelism());

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		setupFiles: [fileURLToPath(new URL("./test/setup-data-root.ts", import.meta.url))],
		testTimeout: 30000,
		maxWorkers: process.platform === "win32" ? maxWindowsWorkers : undefined,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@myharness\/ai$/, replacement: aiSrcIndex },
			{ find: /^@myharness\/ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@myharness\/ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@myharness\/ai\/providers\/(.+)$/, replacement: `${aiSrcProviders}/$1.ts` },
			{ find: /^@myharness\/agent-core$/, replacement: agentSrcIndex },
			{ find: /^@myharness\/tui$/, replacement: tuiSrcIndex },
		],
	},
});
