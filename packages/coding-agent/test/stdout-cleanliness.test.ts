import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/web.ts");
// The real launcher runs `node --import ./scripts/dev-fast-loader.mjs packages/coding-agent/src/web.ts`
// (web-runtime.ps1). Plain node without the loader resolves @myharness/* to the stale compiled
// packages/ai/dist and fails at module load. The child here runs with cwd set to a temporary project,
// so the loader is pinned to an absolute file URL (a bare or "./" specifier would resolve against that cwd).
const devLoaderHref = pathToFileURL(resolve(__dirname, "../../../scripts/dev-fast-loader.mjs")).href;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "myharness-stdout-clean-"));
	tempDirs.push(dir);
	return dir;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const tempRoot = createTempDir();
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	const projectConfigDir = join(projectDir, ".myharness");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectConfigDir, { recursive: true });

	const fakeNpmPath = join(tempRoot, "fake-npm.mjs");
	writeFileSync(
		fakeNpmPath,
		[
			'console.log("changed 1 package in 471ms");',
			'console.log("found 0 vulnerabilities");',
			"process.exit(0);",
		].join("\n"),
		"utf-8",
	);

	writeFileSync(
		join(projectConfigDir, "settings.json"),
		JSON.stringify(
			{
				packages: ["npm:fake-package"],
				npmCommand: [process.execPath, fakeNpmPath],
			},
			null,
			2,
		),
		"utf-8",
	);

	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", devLoaderHref, cliPath, ...args], {
			cwd: projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ stdout, stderr, code });
		});
	});
}

describe("Web launcher version output", () => {
	it("prints --version to stdout when stdout is redirected", async () => {
		const result = await runCli(["--version"]);

		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
		expect(result.stderr).toBe("");
	});
});
