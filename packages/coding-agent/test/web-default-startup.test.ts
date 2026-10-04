import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("starts default Web without console input using isolated state", async () => {
	const dir = mkdtempSync(join(tmpdir(), "myharness-web-default-test-"));
	const child = spawn(
		process.execPath,
		[resolve("dist/cli.js"), "--no-open", "--port", "0", "--offline", "--no-extensions", "--no-context-files"],
		{
			cwd: dir,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, MYHARNESS_CODING_AGENT_DIR: join(dir, "agent"), MYHARNESS_OFFLINE: "1" },
		},
	);
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});
	const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
	try {
		await expect.poll(() => output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], { timeout: 45000 }).toBeTruthy();
		const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
		for (const path of ["/", "/api/state", "/api/settings"]) {
			const response = await fetch(url + path);
			expect(response.status).toBe(200);
			if (path === "/api/settings") {
				const settings = (await response.json()) as { items: { section: string }[] };
				expect(settings.items.some((item) => item.section === "Terminal")).toBe(false);
			}
		}
		const shutdown = await fetch(`${url}/api/shutdown`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: url, "x-myharness-web": "1" },
			body: "{}",
		});
		expect(shutdown.status).toBe(200);
		await Promise.race([
			exited,
			new Promise((_, reject) => setTimeout(() => reject(new Error("Web shutdown timed out")), 10000)),
		]);
	} finally {
		if (child.exitCode === null) {
			child.kill();
			await exited;
		}
		rmSync(dir, { recursive: true, force: true });
	}
}, 60000);
