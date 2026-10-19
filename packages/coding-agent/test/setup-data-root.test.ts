import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const setupUrl = new URL("./setup-data-root.ts", import.meta.url).href;

function runSetup(env: NodeJS.ProcessEnv): { status: number | null; root: string } {
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
			env,
			encoding: "utf8",
			timeout: 15_000,
		},
	);
	return { status: result.status, root: result.stdout.trim() };
}

describe("Vitest data-root ownership", () => {
	it("removes a root created by a normal test process on exit", () => {
		const childEnv = { ...process.env };
		delete childEnv.MYHARNESS_DATA_ROOT;
		const { status, root } = runSetup(childEnv);

		expect(status).toBe(0);
		expect(root).toMatch(/myharness-vitest-data-/);
		expect(existsSync(root)).toBe(false);
	});

	it("ignores a host data root inherited from the parent process", () => {
		// Desktop and Web hosts export their real data root to every child process,
		// so a test run started from one must not adopt it.
		const hostRoot = join(process.cwd(), "data");
		const { status, root } = runSetup({ ...process.env, MYHARNESS_DATA_ROOT: hostRoot });

		expect(status).toBe(0);
		expect(root).toMatch(/myharness-vitest-data-/);
		expect(root).not.toBe(hostRoot);
		expect(existsSync(root)).toBe(false);
	});

	it("keeps an inherited root that already points inside the temp directory", () => {
		const inherited = mkdtempSync(join(tmpdir(), "myharness-vitest-inherited-"));
		try {
			const { status, root } = runSetup({ ...process.env, MYHARNESS_DATA_ROOT: inherited });
			expect(status).toBe(0);
			expect(root).toBe(inherited);
		} finally {
			rmSync(inherited, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});
