import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { startWebBootstrap } from "../src/modes/web/web-mode.ts";
import { openBrowser } from "../src/utils/open-browser.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

const openBrowserMock = vi.mocked(openBrowser);

it("starts default Web without console input using isolated state", async () => {
	const dir = mkdtempSync(join(tmpdir(), "myharness-web-default-test-"));
	const child = spawn(
		process.execPath,
		[resolve("dist/web.js"), "--no-open", "--port", "0", "--offline", "--no-extensions", "--no-context-files"],
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

it("reports the process start time in /api/boot and never opens a browser on startup", async () => {
	openBrowserMock.mockClear();
	const before = Date.now();
	const bootstrap = await startWebBootstrap({ port: 0 });
	try {
		expect(openBrowserMock).not.toHaveBeenCalled();
		const response = await fetch(`${bootstrap.url}api/boot`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { startedAtMs?: unknown; phase?: unknown; version?: unknown };
		expect(body.phase).toBe("starting");
		expect(body.version).toBeTruthy();
		expect(typeof body.startedAtMs).toBe("number");
		const startedAtMs = body.startedAtMs as number;
		expect(Number.isInteger(startedAtMs)).toBe(true);
		expect(startedAtMs).toBeLessThanOrEqual(Date.now());
		expect(startedAtMs).toBeGreaterThan(before - 60_000);
		const wake = await fetch(`${bootstrap.url}api/wake`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: bootstrap.url.slice(0, -1), "x-myharness-web": "1" },
			body: "{}",
		});
		expect(wake.status).toBe(404);
		expect(openBrowserMock).not.toHaveBeenCalled();
	} finally {
		await bootstrap.server.close();
	}
});
