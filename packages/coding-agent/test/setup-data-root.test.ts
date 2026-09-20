import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Vitest data-root ownership", () => {
	it("removes a root created by a normal test process on exit", () => {
		const childEnv = { ...process.env };
		delete childEnv.MYHARNESS_DATA_ROOT;
		const setupUrl = new URL("./setup-data-root.ts", import.meta.url).href;
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx/esm",
				"--input-type=module",
				"-e",
				`await import(${JSON.stringify(setupUrl)}); process.stdout.write(process.env.MYHARNESS_DATA_ROOT ?? "");`,
			],
			{
				cwd: process.cwd(),
				env: childEnv,
				encoding: "utf8",
				timeout: 15_000,
			},
		);

		expect(result.status).toBe(0);
		const root = result.stdout.trim();
		expect(root).toMatch(/myharness-vitest-data-/);
		expect(existsSync(root)).toBe(false);
	});
});
