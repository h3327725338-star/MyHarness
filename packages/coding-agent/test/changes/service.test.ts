import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalPort, ApprovalRequest } from "../../src/changes/approval.ts";
import { ChangeStore } from "../../src/changes/change-store.ts";
import { ChangeControlError } from "../../src/changes/errors.ts";
import type { ChangeControlMode } from "../../src/changes/mode.ts";
import {
	type ChangeCommitted,
	ChangeControl,
	type ChangeGate,
	type ChangeOrigin,
	documentVersionLookup,
} from "../../src/changes/service.ts";
import { createTestWorkspace, disposeTestWorkspaces, type TestWorkspace } from "./helpers.ts";

afterEach(disposeTestWorkspaces);

const FILES = {
	"src/a.ts": "export class Alpha {}\n",
	"src/b.ts": "import { Alpha } from './a';\nnew Alpha();\n",
};
const ORIGIN: ChangeOrigin = { kind: "refactor", sessionId: "s1", toolCallId: "t1" };

function controlFor(
	workspace: TestWorkspace,
	options: { mode?: ChangeControlMode; approval?: ApprovalPort; gates?: ChangeGate[] } = {},
): ChangeControl {
	return new ChangeControl({
		workspaceRoot: workspace.root,
		store: new ChangeStore(workspace.storeRoot),
		mode: () => options.mode ?? "assist",
		approval: options.approval,
		gates: options.gates,
	});
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return error instanceof ChangeControlError ? error.code : `other:${String(error)}`;
	}
	return undefined;
}

const RENAME_PATCH = [{ path: "src/a.ts", edits: [{ oldText: "Alpha", newText: "Beta" }] }];

describe("ChangeControl previews and applies", () => {
	it("applies a previewed patch by its id, approved by policy, and tells the listeners", async () => {
		const workspace = createTestWorkspace(FILES);
		const control = controlFor(workspace);
		const events: ChangeCommitted[] = [];
		control.onCommitted((event) => {
			events.push(event);
		});

		const preview = await control.previewPatch(RENAME_PATCH, { description: "rename" });
		expect(workspace.readText("src/a.ts")).toBe(FILES["src/a.ts"]);
		expect(preview.risk.level).toBe("low");
		expect(preview.diffs.get("src/a.ts")).toContain("+export class Beta {}");

		const outcome = await control.apply(preview.changeset.id, { origin: ORIGIN });

		expect(outcome.approvedBy).toBe("policy");
		expect(outcome.result.status).toBe("committed");
		expect(workspace.readText("src/a.ts")).toBe("export class Beta {}\n");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ origin: ORIGIN, approvedBy: "policy" });
		expect(events[0]?.changeset.files.map((file) => file.path)).toEqual(["src/a.ts"]);
		expect(control.status(preview.changeset.id).entries[0]).toMatchObject({
			state: "committed",
			files: ["src/a.ts"],
		});
	});

	it("applies the same preview only once: a second apply finds the file changed", async () => {
		const workspace = createTestWorkspace(FILES);
		const control = controlFor(workspace);
		const preview = await control.previewPatch(RENAME_PATCH, { description: "rename" });
		await control.apply(preview.changeset.id, { origin: ORIGIN });

		expect(await codeOf(control.apply(preview.changeset.id, { origin: ORIGIN }))).toBe("EDIT_CONFLICT");
	});

	it("refuses to apply when somebody changed a file after the preview, and writes nothing", async () => {
		const workspace = createTestWorkspace(FILES);
		const control = controlFor(workspace);
		const preview = await control.previewPatch(
			[
				{ path: "src/a.ts", edits: [{ oldText: "Alpha", newText: "Beta" }] },
				{ path: "src/b.ts", edits: [{ oldText: "new Alpha()", newText: "new Beta()" }] },
			],
			{ description: "rename" },
		);
		workspace.write("src/b.ts", `${FILES["src/b.ts"]}// edited by hand\n`);

		expect(await codeOf(control.apply(preview.changeset.id, { origin: ORIGIN }))).toBe("EDIT_CONFLICT");
		expect(workspace.readText("src/a.ts")).toBe(FILES["src/a.ts"]);
		expect(workspace.readText("src/b.ts")).toContain("edited by hand");
	});

	it("says what is missing when the id was never previewed", async () => {
		const workspace = createTestWorkspace(FILES);
		const control = controlFor(workspace);

		expect(await codeOf(control.apply("0".repeat(32), { origin: ORIGIN }))).toBe("NOT_FOUND");
		expect(await codeOf(control.apply("../../etc/passwd", { origin: ORIGIN }))).toBe("NOT_FOUND");
	});

	it("discards a preview, and a discarded preview can no longer be applied", async () => {
		const workspace = createTestWorkspace(FILES);
		const control = controlFor(workspace);
		const preview = await control.previewPatch(RENAME_PATCH, { description: "rename" });

		control.discard(preview.changeset.id);

		expect(await codeOf(control.apply(preview.changeset.id, { origin: ORIGIN }))).toBe("NOT_FOUND");
	});
});

describe("ChangeControl approval", () => {
	const RISKY = [{ path: "package-lock.json", content: "{}\n" }];

	it("refuses a risky change when nobody can be asked, and says why", async () => {
		const workspace = createTestWorkspace(FILES);
		const control = controlFor(workspace);
		const preview = await control.previewPatch(RISKY, { description: "lock" });

		const error = await control.apply(preview.changeset.id, { origin: ORIGIN }).catch((e: unknown) => e);

		expect((error as ChangeControlError).code).toBe("PERMIT_REQUIRED");
		expect((error as ChangeControlError).message).toContain("lock file");
		expect(existsSync(workspace.abs("package-lock.json"))).toBe(false);
	});

	it("asks the person, and applies only what they approve", async () => {
		const workspace = createTestWorkspace(FILES);
		const requests: ApprovalRequest[] = [];
		const decide = vi.fn(async (request: ApprovalRequest) => {
			requests.push(request);
			return requests.length === 1
				? ({ approved: false, reason: "not now" } as const)
				: ({ approved: true } as const);
		});
		const control = controlFor(workspace, { approval: { request: decide } });
		const preview = await control.previewPatch(RISKY, { description: "lock" });

		const declined = await control.apply(preview.changeset.id, { origin: ORIGIN }).catch((e: unknown) => e);
		expect((declined as ChangeControlError).code).toBe("PERMIT_REQUIRED");
		expect((declined as ChangeControlError).message).toContain("not now");
		expect(existsSync(workspace.abs("package-lock.json"))).toBe(false);

		const outcome = await control.apply(preview.changeset.id, { origin: ORIGIN });

		expect(outcome.approvedBy).toBe("user");
		expect(existsSync(workspace.abs("package-lock.json"))).toBe(true);
		expect(requests[0]?.message).toContain("package-lock.json");
		expect(requests[0]?.risk.level).toBe("needs_user");
	});

	it("does not ask when change control is off", async () => {
		const workspace = createTestWorkspace(FILES);
		const control = controlFor(workspace, { mode: "off" });
		const preview = await control.previewPatch(RISKY, { description: "lock" });

		const outcome = await control.apply(preview.changeset.id, { origin: ORIGIN });

		expect(outcome.approvedBy).toBe("policy");
	});
});

describe("ChangeControl gates", () => {
	it("lets a gate refuse a change before it is approved, with the gate's own code", async () => {
		const workspace = createTestWorkspace(FILES);
		const gate: ChangeGate = {
			name: "test",
			check: async () => ({
				allow: false,
				code: "REUSE_REVIEW_REQUIRED",
				message: "review first",
				paths: ["src/a.ts"],
			}),
		};
		const control = controlFor(workspace, { gates: [gate] });
		const preview = await control.previewPatch(RENAME_PATCH, { description: "rename" });

		const error = await control.apply(preview.changeset.id, { origin: ORIGIN }).catch((e: unknown) => e);

		expect((error as ChangeControlError).code).toBe("REUSE_REVIEW_REQUIRED");
		expect((error as ChangeControlError).paths).toEqual(["src/a.ts"]);
		expect(workspace.readText("src/a.ts")).toBe(FILES["src/a.ts"]);
	});

	it.each([
		{ recheckAfterApproval: false, rejectAfterApproval: false },
		{ recheckAfterApproval: true, rejectAfterApproval: false },
		{ recheckAfterApproval: true, rejectAfterApproval: true },
	])(
		"honors gate recheck=$recheckAfterApproval rejection=$rejectAfterApproval while skipping off mode",
		async ({ recheckAfterApproval, rejectAfterApproval }) => {
			const workspace = createTestWorkspace(FILES);
			const seen: Array<{ mode: string; bytes: string }> = [];
			const gate: ChangeGate = {
				name: "spy",
				recheckAfterApproval,
				check: async ({ changeset, content, mode }) => {
					seen.push({ mode, bytes: content.after.get(changeset.files[0]?.path ?? "")?.toString("utf8") ?? "" });
					return rejectAfterApproval && seen.length === 2
						? { allow: false, code: "EDIT_CONFLICT", message: "consumer changed during approval" }
						: { allow: true };
				},
			};
			const strict = controlFor(workspace, { mode: "strict", gates: [gate] });
			const preview = await strict.previewPatch(RENAME_PATCH, { description: "rename" });
			await strict.reviewImpact(preview.changeset.id, {
				problem: "rename declaration",
				expectedBehavior: "declaration is Beta",
				rootCause: "declaration name",
				rootPaths: ["src/a.ts"],
				evidence: ["fixture source"],
				affected: [{ path: "src/a.ts", disposition: "modify", reason: "declaration" }],
				compatibility: "isolated gate fixture",
				checks: ["assert written bytes"],
				coverage: "complete",
				limitations: [],
			});
			const applied = strict.apply(preview.changeset.id, { origin: ORIGIN });
			if (rejectAfterApproval) {
				await expect(applied).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
				expect(workspace.readText("src/a.ts")).toBe(FILES["src/a.ts"]);
			} else await applied;
			expect(seen).toEqual(
				Array.from({ length: recheckAfterApproval ? 2 : 1 }, () => ({
					mode: "strict",
					bytes: "export class Beta {}\n",
				})),
			);

			const off = controlFor(createTestWorkspace(FILES), { mode: "off", gates: [gate] });
			const other = await off.previewPatch(RENAME_PATCH, { description: "rename" });
			await off.apply(other.changeset.id, { origin: ORIGIN });
			expect(seen).toHaveLength(recheckAfterApproval ? 2 : 1);
		},
	);
});

describe("ChangeControl workspace edits", () => {
	function editFor(workspace: TestWorkspace, edits: Record<string, Array<[number, number, number, number, string]>>) {
		return {
			changes: Object.fromEntries(
				Object.entries(edits).map(([path, list]) => [
					pathToFileURL(workspace.abs(path)).href,
					list.map(([startLine, startCharacter, endLine, endCharacter, newText]) => ({
						range: {
							start: { line: startLine, character: startCharacter },
							end: { line: endLine, character: endCharacter },
						},
						newText,
					})),
				]),
			),
		};
	}

	it.each([
		{ newName: "Beta", text: "Beta", removed: 5 },
		{ newName: "Omega", text: "Omeg", removed: 4 },
	])(
		"previews a cross-file rename to $newName with verified full or minimal ranges",
		async ({ newName, text, removed }) => {
			const workspace = createTestWorkspace(FILES);
			const control = controlFor(workspace);

			const preview = await control.previewWorkspaceEdit(
				editFor(workspace, {
					"src/a.ts": [[0, 13, 0, 13 + removed, text]],
					"src/b.ts": [
						[0, 9, 0, 9 + removed, text],
						[1, 4, 1, 4 + removed, text],
					],
				}),
				{ description: `Rename Alpha to ${newName}`, source: "rename", rename: { oldName: "Alpha", newName } },
			);

			expect(preview.changeset.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
			expect(preview.changeset.source).toBe("rename");
			await control.apply(preview.changeset.id, { origin: ORIGIN });
			expect(workspace.readText("src/b.ts")).toBe(`import { ${newName} } from './a';\nnew ${newName}();\n`);
		},
	);

	it.each([
		{ content: FILES["src/a.ts"], start: 12, end: 17, text: "Beta", newName: "Beta" },
		{ content: FILES["src/a.ts"], start: 13, end: 17, text: "Omeg", newName: "Beta" },
		{ content: "export class AlphaExtra {}\n", start: 13, end: 17, text: "Omeg", newName: "Omega" },
		{ content: "export class PreAlpha {}\n", start: 16, end: 20, text: "Omeg", newName: "Omega" },
	])(
		"refuses a stale, wrong-name or embedded-token rename ($content), saving nothing",
		async ({ content, start, end, text, newName }) => {
			const workspace = createTestWorkspace({ ...FILES, "src/a.ts": content });
			const control = controlFor(workspace);

			const code = await codeOf(
				control.previewWorkspaceEdit(editFor(workspace, { "src/a.ts": [[0, start, 0, end, text]] }), {
					description: "x",
					rename: { oldName: "Alpha", newName },
				}),
			);

			expect(code).toBe("SNAPSHOT_STALE");
			expect(existsSync(join(workspace.storeRoot, "changesets"))).toBe(false);
		},
	);

	it("checks the document version a server edited against the one the client holds", async () => {
		const workspace = createTestWorkspace(FILES);
		const control = controlFor(workspace);
		const documentChanges = (version: number) => ({
			documentChanges: [
				{
					textDocument: { uri: pathToFileURL(workspace.abs("src/a.ts")).href, version },
					edits: [
						{ range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } }, newText: "Beta" },
					],
				},
			],
		});
		const known = documentVersionLookup({ [workspace.abs("src/a.ts")]: 3 }, workspace.root);

		expect(
			await codeOf(control.previewWorkspaceEdit(documentChanges(2), { description: "x", knownVersion: known })),
		).toBe("SNAPSHOT_STALE");
		await expect(
			control.previewWorkspaceEdit(documentChanges(3), { description: "x", knownVersion: known }),
		).resolves.toMatchObject({ changeset: { files: [{ path: "src/a.ts" }] } });
	});
});

describe("ChangeControl server edits (workspace/applyEdit)", () => {
	const edit = (workspace: TestWorkspace, path: string, to: string) => ({
		changes: {
			[pathToFileURL(workspace.abs(path)).href]: [
				{ range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } }, newText: to },
			],
		},
	});
	const request = (workspace: TestWorkspace, path: string, to: string, signal = new AbortController().signal) => ({
		label: "fix" as string | undefined,
		edit: edit(workspace, path, to),
		definitionId: "typescript",
		workspaceRoot: workspace.root,
		documentVersions: {},
		signal,
	});

	it("refuses an edit nobody authorized and changes nothing", async () => {
		const workspace = createTestWorkspace(FILES);
		const control = controlFor(workspace);

		const response = await control.handleServerEdit(request(workspace, "src/a.ts", "Beta"));

		expect(response.applied).toBe(false);
		expect(response.failureReason).toContain("authorized");
		expect(workspace.readText("src/a.ts")).toBe(FILES["src/a.ts"]);
	});

	it("applies an edit while an authorized window is open, and refuses again once it is closed", async () => {
		const workspace = createTestWorkspace(FILES);
		const control = controlFor(workspace);
		const events: ChangeCommitted[] = [];
		control.onCommitted((event) => {
			events.push(event);
		});
		const window = control.openServerEditWindow({
			label: "organize imports",
			origin: { kind: "server-edit", sessionId: "s1" },
			definitionId: "typescript",
		});

		const applied = await control.handleServerEdit(request(workspace, "src/a.ts", "Beta"));
		window.close();
		const refused = await control.handleServerEdit(request(workspace, "src/a.ts", "Gamma"));

		expect(applied).toEqual({ applied: true });
		expect(workspace.readText("src/a.ts")).toBe("export class Beta {}\n");
		expect(events[0]?.origin.kind).toBe("server-edit");
		expect(refused.applied).toBe(false);
	});

	it("does not take edits from another server than the one the window is for", async () => {
		const workspace = createTestWorkspace(FILES);
		const control = controlFor(workspace);
		control.openServerEditWindow({ label: "x", origin: { kind: "server-edit" }, definitionId: "python" });

		const response = await control.handleServerEdit(request(workspace, "src/a.ts", "Beta"));

		expect(response.applied).toBe(false);
	});

	it("reports why an edit could not be applied, and treats a risky one like any other change", async () => {
		const workspace = createTestWorkspace({ ...FILES, "package-lock.json": '{ "name": "Alpha-x" }\n' });
		const control = controlFor(workspace);
		control.openServerEditWindow({ label: "x", origin: { kind: "server-edit" } });

		const stale = await control.handleServerEdit({
			...request(workspace, "src/a.ts", "Beta"),
			edit: edit(workspace, "src/missing.ts", "Beta"),
		});
		expect(stale.applied).toBe(false);
		expect(stale.failureReason).toContain("does not exist");

		const risky = await control.handleServerEdit(request(workspace, "package-lock.json", "Beta"));
		expect(risky.applied).toBe(false);
		expect(risky.failureReason).toContain("approval");
	});

	it("does not start applying when the request was already abandoned", async () => {
		const workspace = createTestWorkspace(FILES);
		const control = controlFor(workspace);
		control.openServerEditWindow({ label: "x", origin: { kind: "server-edit" } });
		const abandoned = new AbortController();
		abandoned.abort();

		const response = await control.handleServerEdit(request(workspace, "src/a.ts", "Beta", abandoned.signal));

		expect(response.applied).toBe(false);
		expect(workspace.readText("src/a.ts")).toBe(FILES["src/a.ts"]);
	});
});

describe("ChangeControl recovery", () => {
	it("starts by finishing the rollback of a change a crash left unfinished", async () => {
		const workspace = createTestWorkspace(FILES);
		const store = new ChangeStore(workspace.storeRoot);
		const first = controlFor(workspace);
		const preview = await first.previewPatch(RENAME_PATCH, { description: "rename" });
		// A crash after the first file was written: the journal says "applying", the file already has its new content.
		const built = await store.loadChangeset(preview.changeset.id);
		const file = built?.changeset.files[0];
		if (!built || !file) throw new Error("preview was not stored");
		await store.writeBefore(preview.changeset.id, 0, workspace.read("src/a.ts"));
		workspace.write("src/a.ts", built.content.after.get(file.path) ?? "");
		await store.writeJournal({
			version: 1,
			changesetId: preview.changeset.id,
			workspaceRoot: workspace.root,
			owner: { pid: 0, startedAt: 0 },
			state: "applying",
			updatedAt: 0,
			entries: [
				{
					index: 0,
					path: file.path,
					absolutePath: file.absolutePath,
					key: file.key,
					operation: "modify",
					beforeHash: file.baseHash,
					afterHash: file.afterHash,
					state: "committed",
				},
			],
		});

		const second = controlFor(workspace);
		const reports = await second.ready();

		expect(reports).toMatchObject([
			{ changesetId: preview.changeset.id, outcome: "rolled_back", restored: ["src/a.ts"] },
		]);
		expect(workspace.readText("src/a.ts")).toBe(FILES["src/a.ts"]);
		expect(second.status().entries[0]).toMatchObject({ state: "rolled_back" });
	});
});
