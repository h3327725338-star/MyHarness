import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupStaleAtomicWriteTemps, writeFileAtomicallySync } from "../src/utils/atomic-write.ts";

describe("atomic write crash recovery", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "myharness-atomic-recovery-"));
		roots.push(root);
		return root;
	}

	it("leaves a complete target and removes only stale, dead-owner atomic temps", () => {
		const root = createRoot();
		const target = join(root, "workspace.json");
		writeFileAtomicallySync(target, '{"version":1}\n');

		const stale = `${target}.2147483647.${randomUUID()}.tmp`;
		const active = `${target}.${process.pid}.${randomUUID()}.tmp`;
		const unrelated = join(root, "user.tmp");
		writeFileSync(stale, "partial");
		writeFileSync(active, "partial");
		writeFileSync(unrelated, "keep");
		const old = new Date(Date.now() - 60_000);
		utimesSync(stale, old, old);
		utimesSync(active, old, old);

		const result = cleanupStaleAtomicWriteTemps(root, {
			minAgeMs: 1_000,
			isProcessAlive: (pid) => pid === process.pid,
		});

		expect(result.removed).toEqual([stale]);
		expect(existsSync(target)).toBe(true);
		expect(existsSync(active)).toBe(true);
		expect(existsSync(unrelated)).toBe(true);
	});

	it("does not follow a directory reparse point while scanning", () => {
		const root = createRoot();
		const outside = createRoot();
		// The linked tree is deliberately outside the scan root.
		const target = join(outside, "workspace.json");
		const stale = `${target}.2147483647.${randomUUID()}.tmp`;
		writeFileSync(stale, "partial");
		const old = new Date(Date.now() - 60_000);
		utimesSync(stale, old, old);

		try {
			symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
		} catch {
			return;
		}

		cleanupStaleAtomicWriteTemps(root, {
			minAgeMs: 1_000,
			isProcessAlive: () => false,
		});
		expect(existsSync(stale)).toBe(true);
	});
});
