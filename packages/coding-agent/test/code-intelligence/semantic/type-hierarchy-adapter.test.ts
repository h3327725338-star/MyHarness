import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SemanticBackendError, SemanticCapabilityUnsupportedError } from "../../../src/symbols/semantic/errors.ts";
import { clearTypeScriptProgramCache } from "../../../src/symbols/semantic/typescript-heritage.ts";
import {
	createMockEnvironment,
	FULL_CAPABILITIES,
	type MockEnvironment,
	range,
} from "../helpers/configurable-server.ts";

const RUNTIME_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const environments: MockEnvironment[] = [];

afterEach(async () => {
	clearTypeScriptProgramCache();
	for (const environment of environments.splice(0)) await environment.dispose();
});

const TSCONFIG = JSON.stringify({
	compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", noEmit: true },
	include: ["src"],
});

const DOCUMENT_SYMBOLS = {
	"src/base.ts": [{ name: "Base", kind: 5, range: range(0, 0, 0, 20), selectionRange: range(0, 13, 0, 17) }],
	"src/child.ts": [{ name: "Child", kind: 5, range: range(1, 0, 1, 34), selectionRange: range(1, 13, 1, 18) }],
};

function tsEnvironment(withRuntime: boolean): MockEnvironment {
	const environment = createMockEnvironment([
		{
			id: "mock-typescript",
			languages: ["typescript"],
			config: {
				capabilities: { ...FULL_CAPABILITIES, callHierarchyProvider: false },
				documentSymbols: DOCUMENT_SYMBOLS,
			},
			env: withRuntime ? { MYHARNESS_CODE_INTELLIGENCE_ROOT: RUNTIME_ROOT } : undefined,
		},
	]);
	environments.push(environment);
	environment.write("tsconfig.json", TSCONFIG);
	environment.write("src/base.ts", "export class Base {}\n");
	environment.write("src/child.ts", 'import { Base } from "./base";\nexport class Child extends Base {}\n');
	return environment;
}

const options = (environment: MockEnvironment) => ({
	workspaceRoot: environment.root,
	language: "typescript",
	timeoutMs: 20_000,
});

describe("type hierarchy for servers without typeHierarchy", () => {
	it("answers supertypes from the written extends clause and says where the answer came from", async () => {
		const environment = tsEnvironment(true);

		const result = await environment.backend.supertypes(
			{ type: "position", path: "src/child.ts", position: { line: 1, character: 14 } },
			options(environment),
		);

		expect(result.items.map((item) => [item.name, item.path])).toEqual([["Base", "src/base.ts"]]);
		expect(result.items[0].provenance?.definitionId).toBe("mock-typescript");
		expect(result.meta.provenance?.adapter?.name).toBe("typescript-heritage");
		expect(result.meta.hierarchy?.relations).toEqual([{ symbolId: result.items[0].id, relation: "extends" }]);
		expect(result.meta.coverage?.mode).toBe("adapter");
		expect(result.meta.completeness).toBe("complete");
	});

	it("gives hierarchy results the identity file_symbols reports", async () => {
		const environment = tsEnvironment(true);

		const supertypes = await environment.backend.supertypes(
			{ type: "position", path: "src/child.ts", position: { line: 1, character: 14 } },
			options(environment),
		);
		const file = await environment.backend.fileSymbols("src/base.ts", options(environment));

		expect(supertypes.items[0].id).toBe(file.items[0].symbol.id);
	});

	it("answers subtypes by searching the project's classes", async () => {
		const environment = tsEnvironment(true);

		const result = await environment.backend.subtypes(
			{ type: "position", path: "src/base.ts", position: { line: 0, character: 14 } },
			options(environment),
		);

		expect(result.items.map((item) => item.name)).toEqual(["Child"]);
	});

	it("reports environment_blocked instead of guessing when no compiler is available", async () => {
		const environment = tsEnvironment(false);

		const failure = await environment.backend
			.supertypes(
				{ type: "position", path: "src/child.ts", position: { line: 1, character: 14 } },
				options(environment),
			)
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(SemanticBackendError);
		expect((failure as SemanticBackendError).code).toBe("environment_blocked");
	});

	it("reports unsupported for a server that has neither typeHierarchy nor an adapter", async () => {
		const environment = createMockEnvironment([
			{ id: "mock-py", languages: ["python"], config: { capabilities: FULL_CAPABILITIES } },
		]);
		environments.push(environment);
		environment.write("a.py", "class A:\n    pass\n");

		await expect(
			environment.backend.supertypes(
				{ type: "position", path: "a.py", position: { line: 0, character: 6 } },
				{ workspaceRoot: environment.root, language: "python", timeoutMs: 10_000 },
			),
		).rejects.toBeInstanceOf(SemanticCapabilityUnsupportedError);
	});
});

describe("call hierarchy without a provider", () => {
	it("is reported as unsupported rather than as an empty result", async () => {
		const environment = tsEnvironment(true);

		const failure = await environment.backend
			.incomingCalls(
				{ type: "position", path: "src/base.ts", position: { line: 0, character: 14 } },
				options(environment),
			)
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(SemanticCapabilityUnsupportedError);
		expect((failure as Error).message).toBe("language server does not support callHierarchy");
	});
});
