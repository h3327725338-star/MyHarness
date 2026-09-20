import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "../src/config/trust/index.ts";
import { canonicalizePath, resolvePath } from "../src/utils/paths.ts";

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions and inherits from parent directories", () => {
		const store = new ProjectTrustStore(agentDir);
		const parentDir = join(tempDir, "trusted-parent");
		const childDir = join(parentDir, "project");
		mkdirSync(childDir, { recursive: true });

		expect(store.get(childDir)).toBeNull();
		store.set(parentDir, true);
		expect(store.get(childDir)).toBe(true);
		store.set(childDir, false);
		expect(store.get(childDir)).toBe(false);
		store.set(childDir, null);
		expect(store.get(childDir)).toBe(true);
	});

	it("detects trust-requiring project resources", () => {
		const originalHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			mkdirSync(join(tempDir, ".myharness", "agent"), { recursive: true });
			mkdirSync(join(tempDir, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(false);
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

			writeFileSync(join(tempDir, ".myharness", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(true);
			rmSync(join(tempDir, ".myharness", "settings.json"), { force: true });

			mkdirSync(join(cwd, ".myharness"), { recursive: true });
			writeFileSync(join(cwd, ".myharness", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);

			rmSync(join(cwd, ".myharness"), { recursive: true, force: true });
			mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});

	it("exposes stable ids and persistable semantics for trust options", () => {
		const store = new ProjectTrustStore(agentDir);
		const parentPath = canonicalizePath(resolvePath(join(cwd, "..")));
		const options = getProjectTrustOptions(cwd);
		expect(options.map((option) => option.id)).toEqual(["trust", "trust-parent", "do-not-trust"]);
		expect(options[0]).toMatchObject({ id: "trust", trusted: true, savedPath: cwd });
		expect(options[0].updates).toEqual([{ path: cwd, decision: true }]);
		expect(options[1].id).toBe("trust-parent");
		expect(options[1].updates).toEqual([
			{ path: parentPath, decision: true },
			{ path: cwd, decision: null },
		]);
		expect(options[2]).toMatchObject({ id: "do-not-trust", trusted: false });
		expect(options[2].updates).toEqual([{ path: cwd, decision: false }]);

		const withSession = getProjectTrustOptions(cwd, { includeSessionOnly: true });
		expect(withSession.map((option) => option.id)).toEqual([
			"trust",
			"trust-parent",
			"trust-session",
			"do-not-trust",
			"do-not-trust-session",
		]);
		expect(withSession[2].updates).toEqual([]);
		expect(withSession[4].updates).toEqual([]);

		// Options remain driven by the same store semantics (no store writes from option inspection).
		expect(store.get(cwd)).toBeNull();
	});

	it("writes trust.json atomically without leaving temporary files behind", () => {
		const store = new ProjectTrustStore(agentDir);
		store.set(cwd, true);
		store.setMany([{ path: join(tempDir, "other"), decision: false }]);

		const trustPath = join(agentDir, "trust.json");
		const saved = JSON.parse(readFileSync(trustPath, "utf-8"));
		expect(saved).toEqual({
			[canonicalizePath(resolvePath(cwd))]: true,
			[canonicalizePath(resolvePath(join(tempDir, "other")))]: false,
		});
		expect(readdirSync(agentDir).filter((name) => name.includes(".tmp"))).toEqual([]);
	});
});
