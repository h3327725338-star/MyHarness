import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const required = ["MYHARNESS_WEB_SEARCH_SEARXNG_URL", "MYHARNESS_WEB_SEARCH_CRAWL4AI_URL"];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
	console.error(`Missing ${missing.join(" and ")}. Configure the real SearXNG and Crawl4AI endpoints first.`);
	process.exit(2);
}

const vitest = resolve("node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) {
	console.error(`Vitest entry was not found: ${vitest}`);
	process.exit(2);
}

const result = spawnSync(process.execPath, [vitest, "--run", "packages/coding-agent/test/web-search-e2e.test.ts"], {
	stdio: "inherit",
	env: { ...process.env },
});
process.exit(result.status ?? 1);

