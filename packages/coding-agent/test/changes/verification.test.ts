import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeStore } from "../../src/changes/change-store.ts";
import { ChangeControl } from "../../src/changes/service.ts";
import { ChangeVerification, strictToolAllowed } from "../../src/changes/verification.ts";
import { createTestWorkspace, disposeTestWorkspaces } from "./helpers.ts";

afterEach(disposeTestWorkspaces);
function lab(options: { checks?: boolean; strict?: boolean } = {}) {
	const workspace = createTestWorkspace({ "a.ts": "export const a = 1;" });
	const store = new ChangeStore(workspace.storeRoot);
	const run = vi.fn(async () => ({ code: 0, output: "ok" }));
	let snapshot = "first";
	const settings: {
		checks: Array<{ name: string; command: string; args: string[] }>;
		enabled?: boolean;
		maxRepairAttempts?: number;
	} = {
		checks: options.checks === false ? [] : [{ name: "typecheck", command: "approved-check", args: [] }],
	};
	const verification = new ChangeVerification({
		store,
		workspaceRoot: workspace.root,
		settings: () => settings,
		snapshot: async () => snapshot,
		run,
	});
	const control = new ChangeControl({
		store,
		workspaceRoot: workspace.root,
		mode: () => (options.strict ? "strict" : "assist"),
	});
	control.verification = verification;
	return {
		workspace,
		control,
		verification,
		run,
		settings,
		setSnapshot(value: string) {
			snapshot = value;
		},
	};
}
async function apply(l: ReturnType<typeof lab>) {
	const preview = await l.control.previewPatch([{ path: "a.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] }], {
		description: "change a",
	});
	await l.control.apply(preview.changeset.id, { origin: { kind: "edit" } });
}
describe("persistent controlled-change verification", () => {
	it("records debt only for committed changes and clears it after real checks", async () => {
		const l = lab();
		expect((await l.verification.status()).state).toBe("verified");
		await apply(l);
		expect((await l.verification.status()).state).toBe("pending");
		expect((await l.verification.verify()).state).toBe("verified");
		expect(l.run).toHaveBeenCalledTimes(2);
		expect((await l.verification.status()).state).toBe("verified");
		l.setSnapshot("edited elsewhere");
		expect((await l.verification.status()).state).toBe("pending");
	});
	it("does not interpret missing checks as success and strict refuses the write", async () => {
		const l = lab({ checks: false, strict: true });
		await expect(apply(l)).rejects.toMatchObject({ code: "PERMIT_REQUIRED" });
		expect(l.workspace.readText("a.ts")).toContain("a = 1");
	});
	it("preserves unknown verification across a service restart", async () => {
		const l = lab({ checks: false });
		await apply(l);
		expect((await l.verification.verify()).state).toBe("unknown");
		const restored = new ChangeVerification({
			store: l.control.store,
			workspaceRoot: l.workspace.root,
			settings: () => ({}),
			snapshot: async () => "first",
			run: l.run,
		});
		expect((await restored.status()).state).toBe("pending");
	});
	it("detects failures after a passing baseline and refuses stale checks", async () => {
		const l = lab();
		await apply(l);
		l.run.mockResolvedValueOnce({ code: 1, output: "caller needs an argument" });
		expect((await l.verification.verify()).state).toBe("failed");
		l.run.mockImplementationOnce(async () => {
			l.setSnapshot("concurrent edit");
			l.settings.checks.push({ name: "new", command: "unreviewed", args: [] });
			return { code: 0, output: "ok" };
		});
		expect((await l.verification.verify()).state).toBe("unknown");
		expect(l.run).toHaveBeenCalledTimes(3);
		const cancellation = new AbortController();
		l.run.mockImplementationOnce(async () => {
			cancellation.abort();
			return { code: 0, output: "ignored cancellation" };
		});
		expect(await l.verification.verify(cancellation.signal)).toMatchObject({
			state: "unknown",
			reason: "Verification cancelled",
		});
	});
	it.each(["outside.ts", "checks.test.ts"])(
		"keeps automatic repair from unauthorized or verification files (%s)",
		async (path) => {
			const l = lab();
			await apply(l);
			if (path.endsWith(".test.ts")) {
				const authorized = await l.control.previewWrite(path, "export const test = 1;");
				await l.control.apply(authorized.changeset.id, { origin: { kind: "write" } });
			}
			await l.verification.beginRepair();
			const preview = await l.control.previewWrite(path, "export const outside = 1;");
			await expect(l.control.apply(preview.changeset.id, { origin: { kind: "write" } })).rejects.toMatchObject({
				code: "PERMIT_REQUIRED",
			});
		},
	);
	it("allows authorized repair when a previously verified snapshot becomes stale", async () => {
		const l = lab();
		await apply(l);
		await l.verification.verify();
		l.setSnapshot("stale snapshot");
		await l.verification.beginRepair();
		l.settings.checks.length = 0;
		const preview = await l.control.previewPatch(
			[{ path: "a.ts", edits: [{ oldText: "a = 2", newText: "a = 3" }] }],
			{ description: "repair authorized file" },
		);
		await expect(l.control.apply(preview.changeset.id, { origin: { kind: "edit" } })).rejects.toThrow(
			"Verification checks changed during automatic repair",
		);
		l.settings.checks.push({ name: "typecheck", command: "approved-check", args: [] });
		for (const changed of [{ enabled: false }, { maxRepairAttempts: 100 }]) {
			Object.assign(l.settings, changed);
			await expect(l.control.apply(preview.changeset.id, { origin: { kind: "edit" } })).rejects.toMatchObject({
				code: "PERMIT_REQUIRED",
			});
			delete l.settings.enabled;
			delete l.settings.maxRepairAttempts;
		}
		await expect(l.control.apply(preview.changeset.id, { origin: { kind: "edit" } })).resolves.toHaveProperty(
			"approvedBy",
			"policy",
		);
	});
	it.each(["enabled", "maxRepairAttempts"] as const)(
		"refuses success when %s changes during verification",
		async (key) => {
			const l = lab();
			await apply(l);
			l.run.mockImplementationOnce(async () => {
				if (key === "enabled") l.settings.enabled = false;
				else l.settings.maxRepairAttempts = 100;
				return { code: 0, output: "passed under previous policy" };
			});
			expect(await l.verification.verify()).toMatchObject({
				state: "unknown",
				reason: expect.stringContaining("policy changed"),
			});
			expect((await l.verification.status()).state).toBe("pending");
		},
	);
	it("invalidates success when check configuration changes", async () => {
		const l = lab();
		await apply(l);
		await l.verification.verify();
		l.settings.checks.push({ name: "tests", command: "approved-tests", args: [] });
		expect((await l.verification.status()).state).toBe("pending");
	});
	it("retains historical debt without blocking a new task or widening repair permission", async () => {
		const l = lab({ checks: false });
		await apply(l);
		l.verification.beginTask();
		expect((await l.verification.status(true)).state).toBe("verified");
		expect((await l.verification.verify(undefined, true)).state).toBe("verified");
		expect((await l.verification.status()).state).toBe("pending");
		await l.verification.beginRepair(true);
		const attempted = l.control.previewWrite("a.ts", "export const a = 3;");
		await expect(
			attempted.then((p) => l.control.apply(p.changeset.id, { origin: { kind: "write" } })),
		).rejects.toMatchObject({ code: "PERMIT_REQUIRED" });
	});
	it("serializes verification records across independent service instances", async () => {
		const l = lab();
		await apply(l);
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const paused = new Promise<void>((resolve) => {
			release = resolve;
		});
		l.run.mockImplementationOnce(async () => {
			entered();
			await paused;
			return { code: 1, output: "first failed" };
		});
		const first = l.verification.verify();
		await started;
		const otherRun = vi.fn(async () => ({ code: 0, output: "second passed" }));
		const other = new ChangeVerification({
			store: l.control.store,
			workspaceRoot: l.workspace.root,
			settings: () => l.settings,
			snapshot: async () => "first",
			run: otherRun,
		});
		const second = other.verify();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(otherRun).not.toHaveBeenCalled();
		release();
		expect((await first).state).toBe("failed");
		expect((await second).state).toBe("verified");
		expect((await l.verification.status()).state).toBe("verified");
	});

	it("does not trust arbitrary tools sharing a built-in name", () => {
		expect(strictToolAllowed("write", true)).toBe(true);
		expect(strictToolAllowed("write", false)).toBe(false);
		expect(strictToolAllowed("bash", true)).toBe(false);
		expect(strictToolAllowed("custom", true)).toBe(false);
	});
});
