import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/tools/shell/executor.ts";

const ORIGINAL_TEMP = {
	TMPDIR: process.env.TMPDIR,
	TEMP: process.env.TEMP,
	TMP: process.env.TMP,
};

function useUnusableTempDir(): void {
	// A path whose parent does not exist makes the temp-file open fail with ENOENT.
	const invalid = join(
		tmpdir(),
		`myharness-missing-temp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		"nested",
	);
	process.env.TMPDIR = invalid;
	process.env.TEMP = invalid;
	process.env.TMP = invalid;
}

afterEach(() => {
	if (ORIGINAL_TEMP.TMPDIR === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = ORIGINAL_TEMP.TMPDIR;
	if (ORIGINAL_TEMP.TEMP === undefined) delete process.env.TEMP;
	else process.env.TEMP = ORIGINAL_TEMP.TEMP;
	if (ORIGINAL_TEMP.TMP === undefined) delete process.env.TMP;
	else process.env.TMP = ORIGINAL_TEMP.TMP;
});

describe("executeBashWithOperations", () => {
	it("bounds large output and keeps the full result in a temporary file", async () => {
		const fullOutput = `${"x".repeat(200 * 1024)}\n`;
		const result = await executeBashWithOperations("test", process.cwd(), {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from(fullOutput, "utf8"));
				return { exitCode: 0 };
			},
		});

		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		if (result.fullOutputPath) {
			expect(await readFile(result.fullOutputPath, "utf8")).toBe(fullOutput);
			await rm(result.fullOutputPath, { force: true });
		}
	});

	it("keeps the truncated result instead of failing when the temp file cannot be created", async () => {
		useUnusableTempDir();
		const lines = `${Array.from({ length: 3_000 }, (_, index) => `line-${index}`).join("\n")}\n`;

		const result = await executeBashWithOperations("test", process.cwd(), {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from(lines, "utf8"));
				return { exitCode: 0 };
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.truncated).toBe(true);
		expect(result.output).toContain("line-2999");
		expect(result.fullOutputPath).toBeUndefined();
	});

	it("returns a terminal timeout result and stops accepting late output", async () => {
		const result = await executeBashWithOperations(
			"test",
			process.cwd(),
			{
				exec: async (_command, _cwd, { onData, signal }) => {
					onData(Buffer.from("before-timeout\n", "utf8"));
					return new Promise<{ exitCode: number | null }>((resolve) => {
						signal?.addEventListener(
							"abort",
							() => {
								onData(Buffer.from("late-output\n", "utf8"));
								resolve({ exitCode: null });
							},
							{ once: true },
						);
					});
				},
			},
			{ timeout: 0.01 },
		);

		expect(result.timedOut).toBe(true);
		expect(result.cancelled).toBe(false);
		expect(result.output).toContain("before-timeout");
		expect(result.output).not.toContain("late-output");
	});

	it("observes a synchronous backend throw instead of leaking an unhandled rejection", async () => {
		await expect(
			executeBashWithOperations("test", process.cwd(), {
				exec: (() => {
					throw new Error("backend failed before returning a promise");
				}) as never,
			}),
		).rejects.toThrow("backend failed before returning a promise");
	});
});
