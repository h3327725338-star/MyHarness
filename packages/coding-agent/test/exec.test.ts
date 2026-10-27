import { type AddressInfo, createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { execCommand } from "../src/platform/process/exec.ts";

const STUCK_COMMAND = "setInterval(() => {}, 1000);";

function isWindows(): boolean {
	return process.platform === "win32";
}

/** True once the socket closes, false if it is still open after `ms`. */
function whenClosed(socket: Socket, ms: number): Promise<boolean> {
	return new Promise((resolve) => {
		const deadline = setTimeout(() => resolve(false), ms);
		socket.once("close", () => {
			clearTimeout(deadline);
			resolve(true);
		});
	});
}

describe("execCommand cancellation", () => {
	it("reports the timeout exit code instead of 0", async () => {
		const startedAt = Date.now();
		const result = await execCommand(process.execPath, ["-e", STUCK_COMMAND], process.cwd(), {
			timeout: 200,
			killGraceMs: 100,
		});

		expect(result.killed).toBe(true);
		// A timed-out command must never look like a successful one.
		expect(result.code).toBe(124);
		// Must not wait for the force-kill grace after the process is already gone.
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("reports the abort exit code instead of 0", async () => {
		const controller = new AbortController();
		const promise = execCommand(process.execPath, ["-e", STUCK_COMMAND], process.cwd(), {
			signal: controller.signal,
			killGraceMs: 100,
		});
		setTimeout(() => controller.abort(), 100);

		const result = await promise;
		expect(result.killed).toBe(true);
		expect(result.code).toBe(130);
	});

	it("kills immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		const result = await execCommand(process.execPath, ["-e", STUCK_COMMAND], process.cwd(), {
			signal: controller.signal,
			killGraceMs: 100,
		});

		expect(result.killed).toBe(true);
		expect(result.code).toBe(130);
	});

	it("keeps the real exit code for a normal exit", async () => {
		const result = await execCommand(process.execPath, ["-e", "process.exit(3);"], process.cwd(), {
			killGraceMs: 100,
		});

		expect(result.killed).toBe(false);
		expect(result.code).toBe(3);
	});

	it("terminates descendants when the command is cancelled", async () => {
		// Cancelled once the descendant runs, and judged by its connection, which ends with its process. A fixed 120 ms
		// timeout and a marker the descendant wrote 900 ms after it started failed under load, where the kill alone took
		// about a second.
		const server = createServer();
		const connected = new Promise<Socket>((resolve) => server.once("connection", resolve));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		// Left alone, the descendant exits after 30 seconds, so a failed kill does not leave it running.
		const descendant = `require("node:net").connect(${port}, "127.0.0.1"); setTimeout(() => {}, 30_000);`;
		// Detached on Windows: a Node child is otherwise ended with its parent by libuv's job object, and the tree kill
		// would go untested. Elsewhere it stays in the command's process group, which is what gets killed there.
		const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore", detached: process.platform === "win32" }); setInterval(() => {}, 1000);`;
		const controller = new AbortController();
		// The timeout only ends a run whose descendant never connects.
		const running = execCommand(process.execPath, ["-e", parent], process.cwd(), {
			signal: controller.signal,
			timeout: 20_000,
			killGraceMs: 200,
		});
		let socket: Socket | undefined;
		try {
			socket = await Promise.race([connected, running.then(() => undefined)]);
			expect(socket, "the descendant never started").toBeDefined();
			// A killed process resets its connection; the close after it is what counts.
			socket!.on("error", () => undefined);
			const ended = new Promise<boolean>((resolve) => {
				const deadline = setTimeout(() => resolve(false), 5_000);
				socket!.once("close", () => {
					clearTimeout(deadline);
					resolve(true);
				});
			});
			controller.abort();
			const result = await running;
			expect(result.killed).toBe(true);
			expect(await ended, "the descendant outlived the cancellation").toBe(true);
		} finally {
			controller.abort();
			socket?.destroy();
			server.close();
		}
	});

	// taskkill's tree walk goes from parent to child, so it cannot reach a descendant whose parent already exited. The
	// command's job object still holds it.
	it.skipIf(!isWindows())("ends a descendant whose parent already exited when the command is cancelled", async () => {
		const server = createServer();
		const connected = new Promise<Socket>((resolve) => server.once("connection", resolve));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		// Connects once its parent is gone (its stdin, a pipe from the parent, ends); left alone, it exits after 30 seconds.
		const orphan = `process.stdin.on("end", () => require("node:net").connect(${port}, "127.0.0.1").on("error", () => {}).on("close", () => process.exit())).resume(); setTimeout(() => process.exit(), 30_000);`;
		const middle = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(orphan)}], { stdio: ["pipe", "ignore", "ignore"], detached: true }); process.exit();`;
		const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(middle)}], { stdio: "ignore", detached: true }); setInterval(() => {}, 1000);`;
		const controller = new AbortController();
		const running = execCommand(process.execPath, ["-e", parent], process.cwd(), {
			signal: controller.signal,
			timeout: 20_000,
			killGraceMs: 200,
		});
		let socket: Socket | undefined;
		try {
			socket = await Promise.race([connected, running.then(() => undefined)]);
			expect(socket, "the descendant never started").toBeDefined();
			socket!.on("error", () => undefined);
			const ended = whenClosed(socket!, 5_000);
			controller.abort();
			const result = await running;
			expect(result.killed).toBe(true);
			expect(await ended, "the descendant outlived the cancellation").toBe(true);
		} finally {
			controller.abort();
			socket?.destroy();
			server.close();
		}
	});

	// The job object has no kill-on-close: a command that finishes normally leaves its background processes running.
	it("leaves a background descendant running when the command finishes normally", async () => {
		const server = createServer();
		const connected = new Promise<Socket>((resolve) => server.once("connection", resolve));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		// Ends when the test closes the connection, or after 30 seconds.
		const background = `require("node:net").connect(${port}, "127.0.0.1").on("error", () => process.exit()).on("close", () => process.exit()); setTimeout(() => process.exit(), 30_000);`;
		const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(background)}], { stdio: "ignore", detached: true }).unref();`;
		let timer: NodeJS.Timeout | undefined;
		let socket: Socket | undefined;
		try {
			const result = await execCommand(process.execPath, ["-e", parent], process.cwd(), { timeout: 20_000 });
			expect(result.code).toBe(0);
			socket = await Promise.race([
				connected,
				new Promise<undefined>((resolve) => {
					timer = setTimeout(() => resolve(undefined), 10_000);
				}),
			]);
			expect(socket, "the background process never connected").toBeDefined();
			socket!.on("error", () => undefined);
			expect(await whenClosed(socket!, 500), "the background process ended with the command").toBe(false);
		} finally {
			clearTimeout(timer);
			socket?.destroy();
			server.close();
		}
	});

	// On Windows `kill("SIGTERM")` maps to TerminateProcess, so the escalation path
	// can only be exercised where SIGTERM is a catchable signal.
	it.skipIf(isWindows())("escalates to SIGKILL when the child ignores SIGTERM", async () => {
		const startedAt = Date.now();
		const result = await execCommand(
			process.execPath,
			["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
			process.cwd(),
			{ timeout: 150, killGraceMs: 200 },
		);
		const elapsed = Date.now() - startedAt;

		expect(result.killed).toBe(true);
		expect(result.code).toBe(124);
		// The graceful timeout must have elapsed before the forced kill landed.
		expect(elapsed).toBeGreaterThanOrEqual(250);
		expect(elapsed).toBeLessThan(5_000);
	});
});
