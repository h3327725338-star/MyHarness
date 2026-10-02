/**
 * Where the process that owns a Session (holds its writer lock) can be reached by other MyHarness processes.
 *
 * The owner writes `<session>.jsonl.bridge` next to the Session JSONL while it holds the writer lock. Another process
 * that finds the Session locked reads it to attach to the live Session instead of failing (see
 * agent/runtime/session-bridge.ts). The file only holds a loopback port and a random token, no Session content.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";

export interface SessionBridgeDescriptor {
	pid: number;
	port: number;
	token: string;
	startedAt: number;
}

export function getSessionBridgePath(sessionFile: string): string {
	return `${sessionFile}.bridge`;
}

export function writeSessionBridgeDescriptor(sessionFile: string, descriptor: SessionBridgeDescriptor): void {
	writeFileSync(getSessionBridgePath(sessionFile), `${JSON.stringify(descriptor)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

export function readSessionBridgeDescriptor(sessionFile: string): SessionBridgeDescriptor | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(getSessionBridgePath(sessionFile), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const { pid, port, token, startedAt } = value as Partial<SessionBridgeDescriptor>;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
		if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
		if (typeof token !== "string" || token.length === 0) return undefined;
		return { pid, port, token, startedAt: typeof startedAt === "number" ? startedAt : 0 };
	} catch {
		return undefined;
	}
}

/** Remove the descriptor, but only when it still is the one this owner wrote. */
export function removeSessionBridgeDescriptor(sessionFile: string, token: string): void {
	const current = readSessionBridgeDescriptor(sessionFile);
	if (!current || current.token !== token) return;
	rmSync(getSessionBridgePath(sessionFile), { force: true });
}
