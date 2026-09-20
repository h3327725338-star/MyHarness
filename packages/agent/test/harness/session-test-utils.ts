import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@myharness/agent-core";
import { afterEach } from "vitest";

/**
 * Create a directory-link fixture for tests.
 *
 * Windows only allows symbolic links when Developer Mode is enabled or the
 * process has admin privileges, but directory junctions are always available.
 * Node reports junctions as symlinks through `lstat`/`readdir`, so a junction
 * preserves the behavior these fixtures exercise instead of forcing the tests
 * to be skipped.
 */
export async function createDirLink(target: string, linkPath: string): Promise<void> {
	await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

let fileSymlinkSupport: boolean | undefined;

/**
 * Report whether this process can create file symbolic links.
 *
 * Probed once against the real filesystem rather than assuming from the
 * platform, so tests that genuinely require file symlinks still run wherever
 * the OS/account permits it and only skip where the capability is missing.
 */
export function supportsFileSymlinks(): boolean {
	if (fileSymlinkSupport !== undefined) return fileSymlinkSupport;
	const probeRoot = mkdtempSync(join(tmpdir(), "myharness-symlink-probe-"));
	try {
		const target = join(probeRoot, "target.txt");
		writeFileSync(target, "probe");
		symlinkSync(target, join(probeRoot, "link.txt"));
		fileSymlinkSupport = true;
	} catch {
		fileSymlinkSupport = false;
	} finally {
		rmSync(probeRoot, { recursive: true, force: true });
	}
	return fileSymlinkSupport;
}

export function createUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

export function createAssistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const tempDirs: string[] = [];

export function createTempDir(): string {
	const dir = join(tmpdir(), `myharness-agent-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

export function getLatestTempDir(): string {
	return tempDirs[tempDirs.length - 1]!;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});
