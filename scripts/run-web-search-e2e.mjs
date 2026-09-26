import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Real-network Web Search checks: Google/Bing (and any engines named in
// MYHARNESS_WEB_SEARCH_E2E_ENGINES), the real Firefox fallback and page reading.
// Also runs the Firefox transport tests against a local page server.
const packageDir = resolve("packages/coding-agent");
const vitest = resolve(packageDir, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) {
	console.error(`Vitest entry was not found: ${vitest}`);
	process.exit(2);
}

const result = spawnSync(
	process.execPath,
	[vitest, "--run", "test/web-search-firefox.test.ts", "test/web-search-e2e.test.ts", "--fileParallelism=false", "--silent=false"],
	{
		cwd: packageDir,
		stdio: "inherit",
		env: { ...process.env, MYHARNESS_WEB_SEARCH_E2E: "1", MYHARNESS_FIREFOX_E2E: "1" },
	},
);
process.exit(result.status ?? 1);
