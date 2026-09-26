import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Real-network Web Search checks: built-in search engines and page reading, no external services.
const packageDir = resolve("packages/coding-agent");
const vitest = resolve(packageDir, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) {
	console.error(`Vitest entry was not found: ${vitest}`);
	process.exit(2);
}

const result = spawnSync(process.execPath, [vitest, "--run", "test/web-search-e2e.test.ts"], {
	cwd: packageDir,
	stdio: "inherit",
	env: { ...process.env, MYHARNESS_WEB_SEARCH_E2E: "1" },
});
process.exit(result.status ?? 1);
