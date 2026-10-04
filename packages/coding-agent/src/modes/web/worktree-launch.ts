import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { worktreeId } from "../../git/worktrees/display-name.ts";
import type { GitWorktree } from "../../git/worktrees/manager.ts";

export interface WorktreeServiceIdentity {
	id: string;
	path: string;
	token: string;
	metadataAgentDir: string;
}

export function worktreeServiceIdentity(): WorktreeServiceIdentity | undefined {
	const raw = process.env.MYHARNESS_WORKTREE_SERVICE;
	if (!raw) return undefined;
	const identity = JSON.parse(raw) as WorktreeServiceIdentity;
	if (resolve(identity.path) !== resolve(process.cwd())) throw new Error("Worktree service directory mismatch.");
	return identity;
}

interface RunningService {
	url: string;
	token: string;
}

/** Starts the selected checkout, never the main checkout's entry and never dev-web.ps1's replacement flow. */
export class WorktreeLauncher {
	private readonly agentDir: string;
	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	async start(worktree: GitWorktree, graceSeconds: number): Promise<{ url: string; id: string }> {
		if (worktree.isMain) throw new Error("The main copy is not a test copy.");
		if (process.platform !== "win32") throw new Error("Copy startup currently requires Windows.");
		const script = join(worktree.path, "web-runtime.ps1");
		if (!existsSync(script) || !existsSync(join(worktree.path, "packages/coding-agent/src/web.ts"))) {
			throw new Error("This copy does not contain the MyHarness source startup entry.");
		}
		const modeFile = join(worktree.path, "packages/coding-agent/src/modes/web/web-mode.ts");
		if (!existsSync(modeFile) || !readFileSync(modeFile, "utf8").includes("worktreeServiceIdentity")) {
			throw new Error(
				"This copy predates managed copy startup. Update its source before starting it from this menu.",
			);
		}
		const id = worktreeId(worktree.path);
		const directory = join(this.agentDir, "worktrees", "services", id);
		mkdirSync(directory, { recursive: true });
		const release = await lockfile.lock(directory, { retries: { retries: 80, minTimeout: 250, maxTimeout: 1000 } });
		try {
			const record = join(directory, "service.json");
			if (existsSync(record)) {
				const running = JSON.parse(readFileSync(record, "utf8")) as RunningService;
				if (await this.matches(running, id)) return { url: running.url, id };
			}
			// Configuration/credentials are a startup snapshot. Runtime writes remain in the copy's private roots.
			const privateAgent = join(directory, "agent");
			mkdirSync(privateAgent, { recursive: true });
			for (const name of [
				"auth.json",
				"models.json",
				"models-store.json",
				"account-connections.json",
				"web-search-keys.json",
			]) {
				const source = join(this.agentDir, name);
				const target = join(privateAgent, name);
				if (existsSync(source) && !existsSync(target)) copyFileSync(source, target);
			}
			const settingsSource = join(this.agentDir, "settings.json");
			const settingsTarget = join(privateAgent, "settings.json");
			if (!existsSync(settingsTarget)) {
				const settings = existsSync(settingsSource) ? JSON.parse(readFileSync(settingsSource, "utf8")) : {};
				delete settings.sessionDir;
				settings.worktreeShutdownGraceSeconds = graceSeconds;
				writeFileSync(settingsTarget, JSON.stringify(settings), { mode: 0o600 });
			}
			const token = randomUUID();
			const identity: WorktreeServiceIdentity = {
				id,
				path: resolve(worktree.path),
				token,
				metadataAgentDir: this.agentDir,
			};
			const logPath = join(directory, "startup.log");
			const log = openSync(logPath, "w");
			const child = spawn(
				"powershell.exe",
				["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "--port", "0", "--no-open"],
				{
					cwd: worktree.path,
					windowsHide: true,
					env: {
						...process.env,
						MYHARNESS_CODING_AGENT_DIR: privateAgent,
						MYHARNESS_DATA_ROOT: join(directory, "data"),
						MYHARNESS_CODING_AGENT_SESSION_DIR: join(directory, "sessions"),
						MYHARNESS_WORKTREE_SERVICE: JSON.stringify(identity),
					},
					stdio: ["ignore", log, log],
				},
			);
			closeSync(log);
			child.unref();
			let failure: Error | undefined;
			let exited = false;
			child.on("error", (error) => {
				failure = error;
			});
			child.on("exit", () => {
				exited = true;
			});

			const deadline = Date.now() + 180_000;
			while (Date.now() < deadline) {
				if (failure) throw failure;
				const output = readFileSync(logPath, "utf8").slice(-16000);
				const url = output.match(/MyHarness Web UI: (http:\/\/127\.0\.0\.1:\d+\/)/u)?.[1];
				if (url) {
					const running = { url, token };
					if (await this.matches(running, id)) {
						writeFileSync(record, JSON.stringify(running));
						return { url, id };
					}
				}
				if (exited)
					throw new Error("Copy startup failed. Check that its dependencies and source entry are compatible.");
				await new Promise((done) => setTimeout(done, 150));
			}
			if (child.pid)
				spawn("taskkill.exe", ["/PID", String(child.pid), "/T"], { windowsHide: true, stdio: "ignore" });
			throw new Error(`Copy startup timed out. Log: ${join(directory, "startup.log")}`);
		} finally {
			await release();
		}
	}

	private async matches(service: RunningService, id: string): Promise<boolean> {
		if (!/^http:\/\/127\.0\.0\.1:\d+\/$/u.test(service.url)) return false;
		try {
			const response = await fetch(`${service.url}api/worktree-service`, { signal: AbortSignal.timeout(1500) });
			const identity = (await response.json()) as { id?: string; token?: string };
			return response.ok && identity.id === id && identity.token === service.token;
		} catch {
			return false;
		}
	}
}
