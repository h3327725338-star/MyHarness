import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalPort } from "../src/changes/approval.ts";
import { ChangeStore } from "../src/changes/change-store.ts";
import { ChangeControl } from "../src/changes/service.ts";
import type { CodeIntelligenceRouterApi } from "../src/symbols/index/router/types.ts";
import { SemanticBackendError } from "../src/symbols/semantic/errors.ts";
import type { CodeSymbol, RenameProposal, RenameResult } from "../src/symbols/types.ts";
import {
	createRefactorToolDefinition,
	RefactorToolError,
	type RefactorToolInput,
	RefactorToolInputError,
	validateRefactorInput,
} from "../src/tools/refactor.ts";
import type { SymbolsCodeIntelligenceServices, SymbolsIndexPort } from "../src/tools/symbols-runtime.ts";
import { createTestWorkspace, disposeTestWorkspaces, type TestWorkspace } from "./changes/helpers.ts";

afterEach(disposeTestWorkspaces);

const FILES = {
	"src/a.ts": "export class Alpha {}\n",
	"src/b.ts": "import { Alpha } from './a';\nnew Alpha();\n",
	"src/c.ts": "// Alpha is mentioned here, but is another thing\n",
};
const POSITION = { type: "position", path: "src/a.ts", position: { line: 0, character: 14 } } as const;

function proposalFor(workspace: TestWorkspace, newName = "Beta"): RenameProposal {
	const edit = (path: string, startCharacter: number, line = 0) => [
		pathToFileURL(workspace.abs(path)).href,
		[
			{
				range: { start: { line, character: startCharacter }, end: { line, character: startCharacter + 5 } },
				newText: newName,
			},
		],
	];
	return {
		oldName: "Alpha",
		newName,
		location: { path: "src/a.ts" },
		edit: { changes: Object.fromEntries([edit("src/a.ts", 13), edit("src/b.ts", 9)]) },
		definitionId: "mock-ts",
		workspaceRoot: workspace.root,
		documentVersions: {},
		prepared: true,
	};
}

function symbol(name: string): CodeSymbol {
	return {
		id: `src/a.ts:class:${name}:0:13`,
		name,
		namePath: name,
		kind: "class",
		language: "typescript",
		path: "src/a.ts",
		line: 0,
		selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } },
	};
}

interface Harness {
	workspace: TestWorkspace;
	tool: ReturnType<typeof createRefactorToolDefinition>;
	control: ChangeControl;
	rename: ReturnType<typeof vi.fn>;
	searchCode: ReturnType<typeof vi.fn>;
}

function harness(
	options: {
		rename?: (target: unknown, newName: string) => Promise<RenameResult>;
		approval?: ApprovalPort;
		router?: Partial<CodeIntelligenceRouterApi>;
		searchCode?: (pattern: string) => Promise<Array<{ path: string; line: number; text: string }>>;
	} = {},
): Harness {
	const workspace = createTestWorkspace(FILES);
	const empty = { items: [], meta: { source: "semantic" as const, completeness: "complete" as const } };
	const rename = vi.fn(
		options.rename ??
			(async (_target: unknown, newName: string): Promise<RenameResult> => ({
				items: [proposalFor(workspace, newName)],
				meta: { source: "semantic", completeness: "complete" },
			})),
	);
	const searchCode = vi.fn(options.searchCode ?? (async () => []));
	const router = {
		findSymbol: async () => empty,
		fileSymbols: async () => empty,
		findDefinition: async () => empty,
		findReferences: async () => empty,
		findImplementations: async () => empty,
		getDiagnostics: async () => empty,
		rename,
		...options.router,
	} as unknown as CodeIntelligenceRouterApi;
	const services: SymbolsCodeIntelligenceServices = {
		workspaceRoot: workspace.root,
		router,
		index: { ensureFresh: async () => ({}), searchCode, getStats: () => ({}) } as unknown as SymbolsIndexPort,
	};
	const control = new ChangeControl({
		workspaceRoot: workspace.root,
		store: new ChangeStore(workspace.storeRoot),
		approval: options.approval,
	});
	const tool = createRefactorToolDefinition(workspace.root, {
		codeIntelligence: services,
		changeControl: control,
		sessionId: () => "session-1",
	});
	return { workspace, tool, control, rename, searchCode };
}

async function run(h: Harness, input: Record<string, unknown>, signal?: AbortSignal) {
	const result = await h.tool.execute("call-1", input as RefactorToolInput, signal, undefined, undefined as never);
	const first = result.content[0];
	return { text: first && first.type === "text" ? first.text : "", details: result.details };
}

async function failure(h: Harness, input: Record<string, unknown>): Promise<Error> {
	return (await run(h, input).then(
		() => undefined,
		(error: unknown) => error,
	)) as Error;
}

function idOf(text: string): string {
	const match = /changesetId: ([0-9a-f]{32})/u.exec(text);
	if (!match?.[1]) throw new Error(`no changesetId in: ${text}`);
	return match[1];
}

describe("refactor schema", () => {
	interface Branch {
		properties: Record<string, { const?: string }>;
		additionalProperties?: boolean;
	}
	const branches = (): Branch[] => (harness().tool.parameters as unknown as { anyOf: Branch[] }).anyOf;

	it("is a closed set of operation branches", () => {
		const schema = harness().tool.parameters as unknown as { type: string; anyOf: Branch[] };

		expect(schema.type).toBe("object");
		expect(schema.anyOf.map((branch) => branch.properties.operation?.const)).toEqual([
			"preview_rename",
			"preview_patch",
			"apply",
			"status",
			"discard",
			"recover",
		]);
		for (const branch of schema.anyOf) expect(branch.additionalProperties).toBe(false);
	});

	it("rejects every parameter that belongs to another operation, and only those", () => {
		const all = new Set(branches().flatMap((branch) => Object.keys(branch.properties)));
		for (const branch of branches()) {
			const operation = branch.properties.operation?.const ?? "";
			for (const key of all) {
				if (key === "operation") continue;
				const attempt = () => validateRefactorInput({ operation, [key]: "x" });
				if (Object.hasOwn(branch.properties, key)) {
					// Its own parameter is judged by the operation's rules, never as an unknown one.
					try {
						attempt();
					} catch (error) {
						expect((error as Error).message).not.toContain(`does not accept ${key}`);
					}
				} else {
					expect(attempt, `${operation} must not accept ${key}`).toThrow(`does not accept ${key}`);
				}
			}
		}
	});

	it("carries a prompt snippet and guidelines for the model", () => {
		const { tool } = harness();

		expect(tool.name).toBe("refactor");
		expect(tool.promptSnippet).toContain("controlled change");
		expect(tool.promptGuidelines?.join("\n")).toContain("preview_rename");
		expect(tool.promptGuidelines?.join("\n")).toContain("EDIT_CONFLICT");
	});
});

describe("refactor input validation", () => {
	it.each([
		["an unknown operation", { operation: "wipe" }],
		["a missing operation", {}],
		["a field of another operation", { operation: "apply", changesetId: "a".repeat(32), newName: "x" }],
		["a changesetId that is not an id", { operation: "apply", changesetId: "../../x" }],
		["a rename without a target", { operation: "preview_rename", newName: "x" }],
		[
			"a rename target of an unsupported type",
			{ operation: "preview_rename", target: { type: "name_path", namePath: "A" }, newName: "x" },
		],
		[
			"a rename with a negative position",
			{
				operation: "preview_rename",
				target: { type: "position", path: "a", position: { line: -1, character: 0 } },
				newName: "x",
			},
		],
		["a rename with an empty new name", { operation: "preview_rename", target: POSITION, newName: " " }],
		["a patch with no changes", { operation: "preview_patch", description: "d", changes: [] }],
		[
			"a patch entry with both edits and content",
			{
				operation: "preview_patch",
				description: "d",
				changes: [{ path: "a", edits: [{ oldText: "a", newText: "b" }], content: "x" }],
			},
		],
		["a patch entry with neither", { operation: "preview_patch", description: "d", changes: [{ path: "a" }] }],
		[
			"a patch edit with empty oldText",
			{
				operation: "preview_patch",
				description: "d",
				changes: [{ path: "a", edits: [{ oldText: "", newText: "b" }] }],
			},
		],
		[
			"a patch edit with an extra field",
			{
				operation: "preview_patch",
				description: "d",
				changes: [{ path: "a", edits: [{ oldText: "a", newText: "b", all: true }] }],
			},
		],
		["a timeout out of range", { operation: "preview_rename", target: POSITION, newName: "x", timeoutMs: 0 }],
	])("rejects %s", (_label, input) => {
		expect(() => validateRefactorInput(input)).toThrow(RefactorToolInputError);
	});

	it("accepts each operation with exactly its own parameters", () => {
		const id = "a".repeat(32);
		for (const input of [
			{ operation: "preview_rename", target: POSITION, newName: "Beta", expectedName: "Alpha", timeoutMs: 1000 },
			{
				operation: "preview_rename",
				target: { type: "symbol_id", symbolId: "x" },
				newName: "Beta",
				definitionId: "ts",
				language: "typescript",
			},
			{
				operation: "preview_patch",
				description: "d",
				changes: [
					{ path: "a", edits: [{ oldText: "a", newText: "b" }] },
					{ path: "n", content: "x" },
				],
			},
			{ operation: "apply", changesetId: id },
			{ operation: "status" },
			{ operation: "status", changesetId: id },
			{ operation: "discard", changesetId: id },
			{ operation: "recover" },
		]) {
			expect(() => validateRefactorInput(input)).not.toThrow();
		}
	});
});

describe("refactor preview_rename and apply", () => {
	it("previews what the language server proposes without writing, then applies exactly that", async () => {
		const h = harness({
			searchCode: async () => [{ path: "src/c.ts", line: 0, text: "// Alpha is mentioned here" }],
		});

		const preview = await run(h, {
			operation: "preview_rename",
			target: POSITION,
			newName: "Beta",
			expectedName: "Alpha",
		});

		expect(preview.text).toContain("Rename Alpha to Beta");
		expect(preview.text).toContain("~ src/a.ts");
		expect(preview.text).toContain("~ src/b.ts");
		expect(preview.text).toContain("approval: not needed");
		expect(preview.text).toContain("+export class Beta {}");
		expect(preview.text).toContain("src/c.ts:1");
		expect(preview.details).toMatchObject({ operation: "preview_rename", approval: "policy" });
		expect(h.workspace.readText("src/a.ts")).toBe(FILES["src/a.ts"]);
		expect(h.rename.mock.calls[0]?.[0]).toEqual(POSITION);
		expect(h.rename.mock.calls[0]?.[1]).toBe("Beta");

		const applied = await run(h, { operation: "apply", changesetId: idOf(preview.text) });

		expect(applied.text).toContain("committed");
		expect(applied.details).toMatchObject({ operation: "apply", state: "committed", approval: "policy" });
		expect(h.workspace.readText("src/a.ts")).toBe("export class Beta {}\n");
		expect(h.workspace.readText("src/b.ts")).toBe("import { Beta } from './a';\nnew Alpha();\n");
		expect(h.workspace.readText("src/c.ts")).toBe(FILES["src/c.ts"]);
	});

	it("refuses to preview when the position is not the identifier the caller meant", async () => {
		const h = harness();

		const error = await failure(h, {
			operation: "preview_rename",
			target: POSITION,
			newName: "Beta",
			expectedName: "Gamma",
		});

		expect(error).toBeInstanceOf(RefactorToolError);
		expect((error as RefactorToolError).code).toBe("TARGET_AMBIGUOUS");
		expect(existsSync(h.workspace.storeRoot + "/changesets")).toBe(false);
	});

	it("checks a symbol_id's own name against what the server would rename", async () => {
		const h = harness({
			router: {
				resolveSymbol: async () => ({
					items: [symbol("Other")],
					meta: { source: "semantic", completeness: "complete" },
				}),
			},
		});

		const error = await failure(h, {
			operation: "preview_rename",
			target: { type: "symbol_id", symbolId: "src/a.ts:class:Other:0:13" },
			newName: "Beta",
		});

		expect((error as RefactorToolError).code).toBe("TARGET_AMBIGUOUS");
		expect(error.message).toContain("'Other'");
	});

	it("names what a refusing or missing language server means for the caller", async () => {
		const refusing = harness({
			rename: async () => {
				throw new SemanticBackendError(
					"rename_not_allowed",
					"the language server found nothing to rename at this position",
				);
			},
		});
		expect(
			(
				(await failure(refusing, {
					operation: "preview_rename",
					target: POSITION,
					newName: "Beta",
				})) as RefactorToolError
			).code,
		).toBe("RENAME_REFUSED");

		const unsupported = harness({
			rename: async () => {
				throw new SemanticBackendError("unsupported_capability", "language server does not support rename");
			},
		});
		expect(
			(
				(await failure(unsupported, {
					operation: "preview_rename",
					target: POSITION,
					newName: "Beta",
				})) as RefactorToolError
			).code,
		).toBe("CAPABILITY_UNSUPPORTED");

		const unavailable = harness({
			rename: async () => {
				throw new SemanticBackendError("server_unavailable", "language server could not be acquired");
			},
		});
		expect(
			(
				(await failure(unavailable, {
					operation: "preview_rename",
					target: POSITION,
					newName: "Beta",
				})) as RefactorToolError
			).code,
		).toBe("PROJECT_NOT_READY");
	});

	it("says rename is unsupported when the router has no rename at all", async () => {
		const h = harness({ router: { rename: undefined } });

		const error = await failure(h, { operation: "preview_rename", target: POSITION, newName: "Beta" });

		expect((error as RefactorToolError).code).toBe("CAPABILITY_UNSUPPORTED");
	});

	it("passes the routing options and the cancellation signal to the router", async () => {
		const h = harness();
		const controller = new AbortController();

		await run(
			h,
			{
				operation: "preview_rename",
				target: POSITION,
				newName: "Beta",
				definitionId: "ts",
				language: "typescript",
				timeoutMs: 5000,
			},
			controller.signal,
		);

		expect(h.rename.mock.calls[0]?.[2]).toMatchObject({
			mode: "semantic",
			definitionId: "ts",
			language: "typescript",
			timeoutMs: 5000,
			signal: controller.signal,
		});
	});

	it("does not fail the preview when the scan for other mentions fails, and says so", async () => {
		const h = harness({
			searchCode: async () => {
				throw new Error("index is rebuilding");
			},
		});

		const preview = await run(h, { operation: "preview_rename", target: POSITION, newName: "Beta" });

		expect(preview.text).toContain("could not scan the workspace");
		expect(preview.details?.warnings?.join(" ")).toContain("could not scan");
	});

	it("reports a stale server answer instead of writing over unrelated text", async () => {
		const h = harness();
		h.workspace.write("src/b.ts", "import { Gamma } from './a';\nnew Alpha();\n");

		const error = await failure(h, { operation: "preview_rename", target: POSITION, newName: "Beta" });

		expect((error as RefactorToolError).code).toBe("SNAPSHOT_STALE");
		expect(error.message).toContain("src/b.ts");
		expect(h.workspace.readText("src/a.ts")).toBe(FILES["src/a.ts"]);
		expect(h.workspace.readText("src/b.ts")).toBe("import { Gamma } from './a';\nnew Alpha();\n");
	});

	it("reports a server answer whose position no longer exists in the file", async () => {
		const h = harness();
		h.workspace.write("src/b.ts", "// moved\nimport { Alpha } from './a';\nnew Alpha();\n");

		const error = await failure(h, { operation: "preview_rename", target: POSITION, newName: "Beta" });

		expect((error as RefactorToolError).code).toBe("INVALID_EDIT");
		expect(h.workspace.readText("src/a.ts")).toBe(FILES["src/a.ts"]);
	});
});

describe("refactor preview_patch, apply, status, discard and recover", () => {
	const PATCH = {
		operation: "preview_patch",
		description: "Rename the class and add a helper",
		changes: [
			{ path: "src/a.ts", edits: [{ oldText: "Alpha", newText: "Beta" }] },
			{ path: "src/helper.ts", content: "export const helper = 1;\n" },
		],
	};

	it("previews a multi-file patch with a new file, applies it by id and reports it in status", async () => {
		const h = harness();

		const preview = await run(h, PATCH);
		expect(preview.text).toContain("+ src/helper.ts");
		expect(h.workspace.read("src/a.ts").toString()).toBe(FILES["src/a.ts"]);
		expect(existsSync(h.workspace.abs("src/helper.ts"))).toBe(false);

		const id = idOf(preview.text);
		const applied = await run(h, { operation: "apply", changesetId: id });
		expect(applied.text).toContain("approved by: policy");
		expect(h.workspace.readText("src/helper.ts")).toBe("export const helper = 1;\n");

		const status = await run(h, { operation: "status", changesetId: id });
		expect(status.text).toContain(`${id}  committed`);
		const listing = await run(h, { operation: "status" });
		expect(listing.text).toContain("mode: assist");
		expect(listing.text).toContain(id);
	});

	it("asks for approval where the policy cannot give it, and fails cleanly when nobody can answer", async () => {
		const h = harness();
		const preview = await run(h, {
			operation: "preview_patch",
			description: "lock",
			changes: [{ path: "package-lock.json", content: "{}\n" }],
		});
		expect(preview.text).toContain("the user must approve it");
		expect(preview.details).toMatchObject({ approval: "needs_user" });

		const error = await failure(h, { operation: "apply", changesetId: idOf(preview.text) });

		expect((error as RefactorToolError).code).toBe("PERMIT_REQUIRED");
		expect(existsSync(h.workspace.abs("package-lock.json"))).toBe(false);
	});

	it("applies a risky change once the person approves", async () => {
		const request = vi.fn(async () => ({ approved: true }) as const);
		const h = harness({ approval: { request } });
		const preview = await run(h, {
			operation: "preview_patch",
			description: "lock",
			changes: [{ path: "package-lock.json", content: "{}\n" }],
		});

		const applied = await run(h, { operation: "apply", changesetId: idOf(preview.text) });

		expect(applied.text).toContain("approved by: user");
		expect(request).toHaveBeenCalledTimes(1);
		expect(existsSync(h.workspace.abs("package-lock.json"))).toBe(true);
	});

	it("reports a file that changed after the preview as an edit conflict and writes nothing", async () => {
		const h = harness();
		const preview = await run(h, PATCH);
		h.workspace.write("src/a.ts", "export class Alpha {} // edited\n");

		const error = await failure(h, { operation: "apply", changesetId: idOf(preview.text) });

		expect((error as RefactorToolError).code).toBe("EDIT_CONFLICT");
		expect(h.workspace.readText("src/a.ts")).toBe("export class Alpha {} // edited\n");
		expect(existsSync(h.workspace.abs("src/helper.ts"))).toBe(false);
	});

	it("explains an edit that does not match and a path that is not allowed", async () => {
		const h = harness();

		const mismatch = await failure(h, {
			operation: "preview_patch",
			description: "d",
			changes: [{ path: "src/a.ts", edits: [{ oldText: "Nope", newText: "x" }] }],
		});
		expect((mismatch as RefactorToolError).code).toBe("INVALID_EDIT");

		const outside = await failure(h, {
			operation: "preview_patch",
			description: "d",
			changes: [{ path: "../outside.ts", content: "x" }],
		});
		expect((outside as RefactorToolError).code).toBe("PATH_OUT_OF_SCOPE");
	});

	it("discards a preview, and recovers nothing when nothing is unfinished", async () => {
		const h = harness();
		const preview = await run(h, PATCH);
		const id = idOf(preview.text);

		expect((await run(h, { operation: "discard", changesetId: id })).text).toContain("forgot");
		expect(((await failure(h, { operation: "apply", changesetId: id })) as RefactorToolError).code).toBe("NOT_FOUND");
		expect((await run(h, { operation: "recover" })).text).toContain("nothing unfinished");
	});

	it("cuts a very large preview and says the complete result is stored", async () => {
		const h = harness();
		const many = Array.from({ length: 40 }, (_, index) => ({
			path: `src/gen${index}.ts`,
			content: `${"export const value = 1;\n".repeat(300)}`,
		}));

		const preview = await run(h, { operation: "preview_patch", description: "generated", changes: many });

		expect(preview.text.length).toBeLessThanOrEqual(14_100);
		expect(preview.details?.outputTruncated).toBe(true);
		expect(preview.text).toContain("changesetId");
		expect(preview.details?.files).toHaveLength(40);
	});
});
