import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SemanticBackendError } from "../../../src/symbols/semantic/errors.ts";
import type { ApplyEditGateway, SemanticBackendQueryOptions } from "../../../src/symbols/semantic/types.ts";
import type { SymbolTarget } from "../../../src/symbols/types.ts";
import {
	createMockEnvironment,
	FULL_CAPABILITIES,
	type MockEnvironment,
	type MockServerConfig,
	RENAME_CAPABILITIES,
	range,
} from "../helpers/configurable-server.ts";

const environments: MockEnvironment[] = [];

afterEach(async () => {
	for (const environment of environments.splice(0)) await environment.dispose();
});

const SOURCE = "export class Alpha {}\n";
const TARGET: Extract<SymbolTarget, { type: "position" }> = {
	type: "position",
	path: "src/a.ts",
	position: { line: 0, character: 14 },
};
const ALPHA_RANGE = range(0, 13, 0, 18);
const RENAME_EDIT = {
	changes: {
		"@uri:src/a.ts": [{ range: ALPHA_RANGE, newText: "Beta" }],
		"@uri:src/b.ts": [{ range: range(0, 9, 0, 14), newText: "Beta" }],
	},
};

function environmentWith(config: MockServerConfig, options: { applyEditTimeoutMs?: number } = {}): MockEnvironment {
	const environment = createMockEnvironment(
		[
			{
				id: "mock-ts",
				languages: ["typescript"],
				config: { documentSymbols: { "src/a.ts": [] }, ...config },
			},
		],
		options,
	);
	environments.push(environment);
	environment.write("src/a.ts", SOURCE);
	environment.write("src/b.ts", "import { Alpha } from './a.ts';\n");
	return environment;
}

function queryOptions(environment: MockEnvironment): SemanticBackendQueryOptions {
	return { workspaceRoot: environment.root, timeoutMs: 10_000 };
}

function renameConfig(extra: Record<string, unknown> = {}): MockServerConfig {
	return {
		capabilities: RENAME_CAPABILITIES,
		responses: {
			"textDocument/prepareRename": { range: ALPHA_RANGE, placeholder: "Alpha" },
			"textDocument/rename": RENAME_EDIT,
			...extra,
		},
	};
}

async function rejection(promise: Promise<unknown>): Promise<SemanticBackendError> {
	const error = await promise.then(
		() => undefined,
		(cause: unknown) => cause,
	);
	expect(error).toBeInstanceOf(SemanticBackendError);
	return error as SemanticBackendError;
}

describe("semantic rename", () => {
	it("asks the server to prepare and rename, and returns its edit untouched with the document versions", async () => {
		const environment = environmentWith(renameConfig());

		const result = await environment.backend.rename(TARGET, "Beta", queryOptions(environment));

		expect(result.meta).toMatchObject({ source: "semantic", completeness: "complete" });
		expect(result.meta.provenance?.definitionIds).toEqual(["mock-ts"]);
		const [proposal] = result.items;
		expect(proposal).toMatchObject({
			oldName: "Alpha",
			newName: "Beta",
			location: { path: "src/a.ts", range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } } },
			definitionId: "mock-ts",
			prepared: true,
		});
		expect(Object.keys((proposal?.edit as { changes: object }).changes)).toHaveLength(2);
		expect(Object.values(proposal?.documentVersions ?? {})).toEqual([1]);

		const sent = environment.log("mock-ts").filter((entry) => String(entry.method).includes("ename"));
		expect(sent.map((entry) => entry.method)).toEqual(["textDocument/prepareRename", "textDocument/rename"]);
		expect(sent[1]?.params).toMatchObject({ newName: "Beta", position: { line: 0, character: 14 } });
	});

	it("takes the old name from the source in UTF-16 units, also after characters outside the BMP", async () => {
		const environment = environmentWith(
			renameConfig({ "textDocument/prepareRename": { range: range(0, 15, 0, 20), placeholder: "value" } }),
		);
		environment.write("src/a.ts", "/* \u{1F600} */ const value = 1;\n");

		const result = await environment.backend.rename(
			{ type: "position", path: "src/a.ts", position: { line: 0, character: 17 } },
			"amount",
			queryOptions(environment),
		);

		expect(result.items[0]?.oldName).toBe("value");
	});

	it("refuses a position the server cannot rename, without sending the rename request", async () => {
		const environment = environmentWith(renameConfig({ "textDocument/prepareRename": null }));

		const error = await rejection(environment.backend.rename(TARGET, "Beta", queryOptions(environment)));

		expect(error.code).toBe("rename_not_allowed");
		expect(environment.log("mock-ts").some((entry) => entry.method === "textDocument/rename")).toBe(false);
	});

	it("reports the server's own reason when it refuses to rename, and a retryable error as a failed request", async () => {
		const refused = environmentWith(
			renameConfig({
				"textDocument/prepareRename": { $error: { code: -32803, message: "cannot rename a keyword" } },
			}),
		);
		const refusal = await rejection(refused.backend.rename(TARGET, "Beta", queryOptions(refused)));
		expect(refusal.code).toBe("rename_not_allowed");
		expect(refusal.message).toContain("cannot rename a keyword");

		const cancelled = environmentWith(
			renameConfig({ "textDocument/rename": { $error: { code: -32801, message: "content modified" } } }),
		);
		const failure = await rejection(cancelled.backend.rename(TARGET, "Beta", queryOptions(cancelled)));
		expect(failure.code).toBe("request_failed");
	});

	it("reads the identifier from the source when the server has no prepareRename, and says so", async () => {
		const environment = environmentWith({
			capabilities: { ...FULL_CAPABILITIES, renameProvider: true },
			responses: { "textDocument/rename": RENAME_EDIT },
		});

		const result = await environment.backend.rename(TARGET, "Beta", queryOptions(environment));

		expect(result.items[0]).toMatchObject({ oldName: "Alpha", prepared: false });
		expect(result.meta.completeness).toBe("partial");
		expect(result.meta.warnings?.join(" ")).toContain("no prepareRename");
		expect(environment.log("mock-ts").some((entry) => entry.method === "textDocument/prepareRename")).toBe(false);
	});

	it("reads the identifier from the source when prepareRename answers with the default behavior", async () => {
		const environment = environmentWith(renameConfig({ "textDocument/prepareRename": { defaultBehavior: true } }));

		const result = await environment.backend.rename(TARGET, "Beta", queryOptions(environment));

		expect(result.items[0]).toMatchObject({ oldName: "Alpha", prepared: true });
		expect(result.items[0]?.location.range).toEqual({
			start: { line: 0, character: 13 },
			end: { line: 0, character: 18 },
		});
	});

	it("warns when the server's placeholder is not the text at the range", async () => {
		const environment = environmentWith(
			renameConfig({ "textDocument/prepareRename": { range: ALPHA_RANGE, placeholder: "Something" } }),
		);

		const result = await environment.backend.rename(TARGET, "Beta", queryOptions(environment));

		expect(result.items[0]?.oldName).toBe("Alpha");
		expect(result.meta.completeness).toBe("partial");
		expect(result.meta.warnings?.join(" ")).toContain("Something");
	});

	it("says unsupported when the server offers no rename", async () => {
		const environment = environmentWith({ capabilities: FULL_CAPABILITIES });

		const error = await rejection(environment.backend.rename(TARGET, "Beta", queryOptions(environment)));

		expect(error.code).toBe("unsupported_capability");
		expect(error.capability).toBe("rename");
	});

	it.each([
		["empty", ""],
		["with a space", "two words"],
		["with a line break", "a\nb"],
		["longer than 255 characters", "x".repeat(256)],
	])("refuses a new name that is %s before any request is sent", async (_label, name) => {
		const environment = environmentWith(renameConfig());

		const error = await rejection(environment.backend.rename(TARGET, name, queryOptions(environment)));

		expect(error.code).toBe("rename_not_allowed");
		expect(environment.log("mock-ts").some((entry) => String(entry.method).includes("ename"))).toBe(false);
	});

	it("refuses to rename a symbol to its own name", async () => {
		const environment = environmentWith(renameConfig());

		const error = await rejection(environment.backend.rename(TARGET, "Alpha", queryOptions(environment)));

		expect(error.code).toBe("rename_not_allowed");
		expect(error.message).toContain("same as the current name");
	});

	it("refuses an answer that carries no edit", async () => {
		const environment = environmentWith(renameConfig({ "textDocument/rename": null }));

		const error = await rejection(environment.backend.rename(TARGET, "Beta", queryOptions(environment)));

		expect(error.code).toBe("rename_not_allowed");
		expect(error.message).toContain("no edit");
	});

	it("refuses a position outside the document", async () => {
		const environment = environmentWith(renameConfig());

		const error = await rejection(
			environment.backend.rename(
				{ type: "position", path: "src/a.ts", position: { line: 9, character: 0 } },
				"Beta",
				queryOptions(environment),
			),
		);

		expect(error.code).toBe("invalid_document_position");
	});

	it("refuses a target that is not a position", async () => {
		const environment = environmentWith(renameConfig());

		const error = await rejection(
			environment.backend.rename(
				{ type: "symbol_id", symbolId: "x" } as unknown as Extract<SymbolTarget, { type: "position" }>,
				"Beta",
				queryOptions(environment),
			),
		);

		expect(error.code).toBe("unsupported_target");
	});
});

describe("server-initiated edits (workspace/applyEdit)", () => {
	const APPLY_EDIT = { changes: { "@uri:src/a.ts": [{ range: ALPHA_RANGE, newText: "Beta" }] } };

	function applyEditEnvironment(options: { applyEditTimeoutMs?: number } = {}): MockEnvironment {
		return environmentWith({ capabilities: FULL_CAPABILITIES, applyEditOnCommand: APPLY_EDIT }, options);
	}

	/** The client of the mock server, once the backend has set the session up. */
	async function serverClient(environment: MockEnvironment) {
		await environment.backend.fileSymbols("src/a.ts", queryOptions(environment));
		const managed = await environment.manager.acquire({
			workspaceRoot: environment.root,
			filePath: join(environment.root, "src", "a.ts"),
			language: "typescript",
		});
		return managed.client;
	}

	async function runCommand(environment: MockEnvironment): Promise<{ applyEditResponse: unknown }> {
		const client = await serverClient(environment);
		return client.request<{ applyEditResponse: unknown }>(
			"workspace/executeCommand",
			{ command: "fixture.apply" },
			{ timeoutMs: 10_000 },
		);
	}

	it("refuses an edit nobody authorized, and says why", async () => {
		const environment = applyEditEnvironment();

		const result = await runCommand(environment);

		expect(result.applyEditResponse).toMatchObject({ applied: false });
		expect((result.applyEditResponse as { failureReason: string }).failureReason).toContain("authorized");
	});

	it("hands an authorized edit to the gateway and returns what really happened", async () => {
		const environment = applyEditEnvironment();
		const seen: unknown[] = [];
		const gateway: ApplyEditGateway = {
			async apply(request) {
				seen.push(request);
				return { applied: true };
			},
		};
		environment.backend.setApplyEditGateway(gateway);

		const result = await runCommand(environment);

		expect(result.applyEditResponse).toEqual({ applied: true });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			label: "fixture edit",
			definitionId: "mock-ts",
			workspaceRoot: environment.root,
		});
		const edit = (seen[0] as { edit: { changes: Record<string, unknown> } }).edit;
		expect(Object.keys(edit.changes)[0]).toMatch(/^file:\/\/.*src\/a\.ts$/u);
	});

	it("passes on the gateway's reason when the edit was not applied", async () => {
		const environment = applyEditEnvironment();
		environment.backend.setApplyEditGateway({
			apply: async () => ({ applied: false, failureReason: "a file changed since the plan" }),
		});

		const result = await runCommand(environment);

		expect(result.applyEditResponse).toEqual({ applied: false, failureReason: "a file changed since the plan" });
	});

	it("answers applied:false when the gateway fails, instead of leaving the server waiting", async () => {
		const environment = applyEditEnvironment();
		environment.backend.setApplyEditGateway({
			apply: async () => {
				throw new Error("disk is full");
			},
		});

		const result = await runCommand(environment);

		expect(result.applyEditResponse).toMatchObject({ applied: false });
		expect((result.applyEditResponse as { failureReason: string }).failureReason).toContain("disk is full");
	});

	it("stops waiting for a gateway that does not answer, tells it to stop, and keeps serving other requests", async () => {
		const environment = applyEditEnvironment({ applyEditTimeoutMs: 300 });
		let aborted = false;
		environment.backend.setApplyEditGateway({
			apply: (request) =>
				new Promise((_resolve, reject) => {
					request.signal.addEventListener("abort", () => {
						aborted = true;
						reject(new Error("stopped"));
					});
				}),
		});

		const command = runCommand(environment);
		// While the server waits for its edit, the client still answers its own queries.
		const symbols = await environment.backend.fileSymbols("src/a.ts", queryOptions(environment));
		expect(symbols.meta.source).toBe("semantic");
		const result = await command;

		expect(aborted).toBe(true);
		expect(result.applyEditResponse).toMatchObject({ applied: false });
		expect((result.applyEditResponse as { failureReason: string }).failureReason).toContain("in time");
	});

	it("refuses a request without an edit and never asks the gateway", async () => {
		const environment = environmentWith({
			capabilities: FULL_CAPABILITIES,
			applyEditRawParams: { label: "no edit" },
		});
		let asked = false;
		environment.backend.setApplyEditGateway({
			apply: async () => {
				asked = true;
				return { applied: true };
			},
		});

		const result = await runCommand(environment);

		expect(result.applyEditResponse).toMatchObject({ applied: false });
		expect((result.applyEditResponse as { failureReason: string }).failureReason).toContain("no workspace edit");
		expect(asked).toBe(false);
	});
});
