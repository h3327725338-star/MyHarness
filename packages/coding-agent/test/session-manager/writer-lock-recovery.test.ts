import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/session/manager/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const sessionManagerSource = pathToFileURL(
	resolve(repoRoot, "packages/coding-agent/src/session/manager/index.ts"),
).href;

describe("SessionManager writer-lock recovery", () => {
	it.runIf(process.platform === "win32")(
		"recovers a session after the owning process is forcibly terminated",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "myharness-writer-lock-test-"));
			let child: ReturnType<typeof spawn> | undefined;
			try {
				const childCode = `import { SessionManager } from ${JSON.stringify(sessionManagerSource)}; const session = SessionManager.create(${JSON.stringify(root)}, ${JSON.stringify(root)}); const file = session.getSessionFile(); session.acquireWriterLock(); process.stdout.write(JSON.stringify({ file }) + "\\n"); setInterval(() => {}, 1000);`;
				child = spawn(process.execPath, ["--import", "tsx", "-e", childCode], {
					cwd: repoRoot,
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				let stderr = "";
				child.stderr?.on("data", (chunk) => {
					stderr += chunk.toString();
				});
				const ready = await new Promise<{ file: string }>((resolveReady, reject) => {
					const timer = setTimeout(() => reject(new Error(`writer child did not start: ${stderr}`)), 60_000);
					let stdout = "";
					child?.stdout?.on("data", (chunk) => {
						stdout += chunk.toString();
						const newline = stdout.indexOf("\n");
						if (newline === -1) return;
						clearTimeout(timer);
						resolveReady(JSON.parse(stdout.slice(0, newline)) as { file: string });
					});
					child?.once("error", (error) => {
						clearTimeout(timer);
						reject(error);
					});
					child?.once("close", (code) => {
						clearTimeout(timer);
						reject(new Error(`writer child exited before start (${code}): ${stderr}`));
					});
				});

				const lockPath = `${ready.file}.lock`;
				const ownerPath = `${lockPath}.owner`;
				execFileSync("taskkill", ["/PID", String(child.pid), "/F"], { stdio: "ignore" });
				await new Promise<void>((resolveClosed) => child?.once("close", () => resolveClosed()));

				expect(existsSync(lockPath)).toBe(true);
				expect(existsSync(ownerPath)).toBe(true);

				const reopened = SessionManager.open(ready.file);
				expect(() => reopened.acquireWriterLock()).not.toThrow();
				reopened.releaseWriterLock();
			} finally {
				if (child && child.exitCode === null) {
					try {
						execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
					} catch {
						// The child may already have exited after the test assertion.
					}
				}
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});
