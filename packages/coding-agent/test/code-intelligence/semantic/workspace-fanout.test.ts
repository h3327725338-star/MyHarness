import { afterEach, describe, expect, it } from "vitest";
import { buildWorkspaceInventory } from "../../../src/symbols/index/workspace-inventory.ts";
import { SemanticBackendError } from "../../../src/symbols/semantic/errors.ts";
import type { SemanticBackendQueryOptions } from "../../../src/symbols/semantic/types.ts";
import {
	createMockEnvironment,
	FULL_CAPABILITIES,
	type MockEnvironment,
	range,
} from "../helpers/configurable-server.ts";

const environments: MockEnvironment[] = [];

afterEach(async () => {
	for (const environment of environments.splice(0)) await environment.dispose();
});

function track(environment: MockEnvironment): MockEnvironment {
	environments.push(environment);
	return environment;
}

function inventory(files: ReadonlyArray<readonly [string, string]>, markers: string[] = []) {
	return buildWorkspaceInventory({
		files: files.map(([path, language]) => ({ path, language, size: 1, hash: "h" })),
		markers,
		complete: true,
		limits: [],
	});
}

function queryOptions(
	environment: MockEnvironment,
	extra: Partial<SemanticBackendQueryOptions> = {},
): SemanticBackendQueryOptions {
	return { workspaceRoot: environment.root, timeoutMs: 10_000, limit: 20, ...extra };
}

const ALPHA_TS = {
	name: "Alpha",
	kind: 5,
	path: "src/a.ts",
	range: range(0, 0, 0, 20),
};
const ALPHA_PY = {
	name: "Alpha",
	kind: 5,
	path: "pkg/alpha.py",
	range: range(0, 0, 1, 8),
};
const TS_TREE = {
	"src/a.ts": [{ name: "Alpha", kind: 5, range: range(0, 0, 0, 20), selectionRange: range(0, 13, 0, 18) }],
};
const PY_TREE = {
	"pkg/alpha.py": [{ name: "Alpha", kind: 5, range: range(0, 0, 1, 8), selectionRange: range(0, 6, 0, 11) }],
};

function twoLanguageEnvironment(pyExtra: Record<string, unknown> = {}): MockEnvironment {
	const environment = track(
		createMockEnvironment([
			{
				id: "mock-ts",
				languages: ["typescript"],
				config: { capabilities: FULL_CAPABILITIES, workspaceSymbols: [ALPHA_TS], documentSymbols: TS_TREE },
			},
			{
				id: "mock-py",
				languages: ["python"],
				config: {
					capabilities: FULL_CAPABILITIES,
					workspaceSymbols: [ALPHA_PY],
					documentSymbols: PY_TREE,
					...pyExtra,
				},
			},
			{ id: "mock-rust", languages: ["rust"], config: { capabilities: FULL_CAPABILITIES } },
		]),
	);
	environment.write("src/a.ts", "export class Alpha {}\n");
	environment.write("pkg/alpha.py", "class Alpha:\n    pass\n");
	return environment;
}

const LANGUAGES = inventory([
	["src/a.ts", "typescript"],
	["pkg/alpha.py", "python"],
]);

describe("workspace symbols across language servers", () => {
	it("queries the servers of the languages the workspace contains and merges hits with provenance", async () => {
		const environment = twoLanguageEnvironment();

		const result = await environment.backend.workspaceSymbols(
			"Alpha",
			queryOptions(environment, { workspaceInventory: LANGUAGES }),
		);

		expect(result.items.map((symbol) => [symbol.path, symbol.provenance?.definitionId]).sort()).toEqual([
			["pkg/alpha.py", "mock-py"],
			["src/a.ts", "mock-ts"],
		]);
		expect(result.meta.completeness).toBe("complete");
		expect(result.meta.provenance?.definitionIds).toEqual(expect.arrayContaining(["mock-ts", "mock-py"]));
		expect(result.meta.coverage?.mode).toBe("inventory");
		expect(
			result.meta.coverage?.entries
				.filter((entry) => entry.status === "ok")
				.map((entry) => entry.definitionId)
				.sort(),
		).toEqual(["mock-py", "mock-ts"]);
		// The rust server is registered but the workspace has no rust files: it must not even be started.
		expect(environment.log("mock-rust")).toEqual([]);
	});

	it("gives workspace hits the same identity file_symbols reports for the same object", async () => {
		const environment = twoLanguageEnvironment();

		const workspace = await environment.backend.workspaceSymbols(
			"Alpha",
			queryOptions(environment, { workspaceInventory: LANGUAGES }),
		);
		const file = await environment.backend.fileSymbols(
			"src/a.ts",
			queryOptions(environment, { language: "typescript" }),
		);

		const hit = workspace.items.find((symbol) => symbol.path === "src/a.ts");
		expect(hit?.id).toBe(file.items[0].symbol.id);
		expect(hit?.selectionRange).toEqual(range(0, 13, 0, 18));
	});

	it("keeps answering when one server fails and reports the failure in coverage", async () => {
		const environment = twoLanguageEnvironment({ workspaceSymbolError: { code: -32603, message: "boom" } });

		const result = await environment.backend.workspaceSymbols(
			"Alpha",
			queryOptions(environment, { workspaceInventory: LANGUAGES }),
		);

		expect(result.items.map((symbol) => symbol.path)).toEqual(["src/a.ts"]);
		expect(result.meta.completeness).toBe("partial");
		const failed = result.meta.coverage?.entries.find((entry) => entry.definitionId === "mock-py");
		expect(failed?.status).toBe("failed");
		expect(failed?.detail).toContain("boom");
		expect(result.meta.warnings?.join("\n")).toContain("did not answer");
	});

	it("reports a server that misses the deadline as timed out and still returns the others", async () => {
		const environment = twoLanguageEnvironment({ workspaceSymbolDelayMs: 4_000 });

		const result = await environment.backend.workspaceSymbols(
			"Alpha",
			queryOptions(environment, { workspaceInventory: LANGUAGES, timeoutMs: 1_500 }),
		);

		expect(result.items.map((symbol) => symbol.path)).toEqual(["src/a.ts"]);
		expect(result.meta.completeness).toBe("partial");
		expect(result.meta.coverage?.entries.find((entry) => entry.definitionId === "mock-py")?.status).toBe("timeout");
	});

	it("queries strictly the explicit definition and surfaces its failure instead of using another server", async () => {
		const environment = twoLanguageEnvironment({ workspaceSymbolError: { code: -32603, message: "boom" } });

		await expect(
			environment.backend.workspaceSymbols(
				"Alpha",
				queryOptions(environment, { workspaceInventory: LANGUAGES, definitionId: "mock-py" }),
			),
		).rejects.toBeInstanceOf(SemanticBackendError);

		expect(environment.log("mock-ts")).toEqual([]);
	});

	it("applies path and kind filters before the limit so a correct hit is not cut off", async () => {
		const items = [
			{ name: "item1", kind: 12, path: "src/one.ts", range: range(0, 0, 0, 5) },
			{ name: "item2", kind: 12, path: "src/two.ts", range: range(0, 0, 0, 5) },
			{ name: "item3", kind: 5, path: "src/three.ts", range: range(0, 0, 0, 5) },
			{ name: "item4", kind: 12, path: "lib/four.ts", range: range(0, 0, 0, 5) },
			{ name: "item5", kind: 5, path: "lib/five.ts", range: range(0, 0, 0, 5) },
		];
		const environment = track(
			createMockEnvironment([
				{
					id: "mock-ts",
					languages: ["typescript"],
					config: { capabilities: FULL_CAPABILITIES, workspaceSymbols: items },
				},
			]),
		);
		for (const item of items) environment.write(item.path, `${item.name}\n`);

		const result = await environment.backend.workspaceSymbols(
			"item",
			queryOptions(environment, { language: "typescript", limit: 1, path: "lib", kinds: ["class"] }),
		);

		expect(result.items.map((symbol) => symbol.name)).toEqual(["item5"]);
		expect(result.meta.completeness).toBe("complete");
	});

	it("searches one project per anchor document for servers that only search the last opened project", async () => {
		const environment = track(
			createMockEnvironment([
				{
					id: "mock-typescript",
					languages: ["typescript"],
					config: {
						capabilities: FULL_CAPABILITIES,
						filterByQuery: false,
						workspaceSymbolsByLastOpened: {
							"packages/a/": [
								{ name: "FromA", kind: 5, path: "packages/a/src/a.ts", range: range(0, 0, 0, 20) },
							],
							"packages/b/": [
								{ name: "FromB", kind: 5, path: "packages/b/src/b.ts", range: range(0, 0, 0, 20) },
							],
						},
						documentSymbols: {
							"packages/a/src/a.ts": [
								{ name: "FromA", kind: 5, range: range(0, 0, 0, 20), selectionRange: range(0, 13, 0, 18) },
							],
							"packages/b/src/b.ts": [
								{ name: "FromB", kind: 5, range: range(0, 0, 0, 20), selectionRange: range(0, 13, 0, 18) },
							],
						},
					},
				},
			]),
		);
		environment.write("packages/a/src/a.ts", "export class FromA {}\n");
		environment.write("packages/b/src/b.ts", "export class FromB {}\n");
		const projects = inventory(
			[
				["packages/a/src/a.ts", "typescript"],
				["packages/b/src/b.ts", "typescript"],
			],
			["packages/a/tsconfig.json", "packages/b/tsconfig.json"],
		);

		const result = await environment.backend.workspaceSymbols(
			"From",
			queryOptions(environment, { workspaceInventory: projects }),
		);

		expect(result.items.map((symbol) => symbol.name).sort()).toEqual(["FromA", "FromB"]);
		const requests = environment
			.log("mock-typescript")
			.filter((entry) => entry.kind === "request" && entry.method === "workspace/symbol");
		expect(requests.map((entry) => String(entry.lastOpened).split("/").slice(0, 2).join("/"))).toEqual([
			"packages/a",
			"packages/b",
		]);
		expect(result.meta.coverage?.entries.map((entry) => entry.project).sort()).toEqual(["packages/a", "packages/b"]);
	});

	it("skips malformed items, keeps the valid ones and says so", async () => {
		const environment = track(
			createMockEnvironment([
				{
					id: "mock-ts",
					languages: ["typescript"],
					config: {
						capabilities: FULL_CAPABILITIES,
						documentSymbols: TS_TREE,
						rawWorkspaceSymbols: [
							{ name: "Alpha", kind: 5, location: { path: "src/a.ts", range: range(0, 0, 0, 20) } },
							{ bogus: true },
							"not an object",
						],
					},
				},
			]),
		);
		environment.write("src/a.ts", "export class Alpha {}\n");

		const result = await environment.backend.workspaceSymbols(
			"Alpha",
			queryOptions(environment, { language: "typescript" }),
		);

		expect(result.items.map((symbol) => symbol.name)).toEqual(["Alpha"]);
		expect(result.meta.completeness).toBe("partial");
		expect(result.meta.warnings).toContain("skipped malformed workspace symbol item");
	});

	it("falls back to priority order and says so when no workspace inventory is available", async () => {
		const environment = twoLanguageEnvironment();

		const result = await environment.backend.workspaceSymbols("Alpha", queryOptions(environment, { maxServers: 2 }));

		expect(result.meta.coverage?.mode).toBe("unranked");
		expect(result.meta.coverage?.inventory).toBeUndefined();
	});
});
