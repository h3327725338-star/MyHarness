import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { CodeSymbolIndex } from "../../../src/symbols/index/code-index.ts";
import { LightweightCodeIntelligenceBackend } from "../../../src/symbols/index/lightweight/backend.ts";

interface Project {
	root: string;
	agentDir: string;
}

const projects = new Set<Project>();

afterEach(async () => {
	for (const project of projects) {
		await rm(project.root, { recursive: true, force: true });
		await rm(project.agentDir, { recursive: true, force: true });
	}
	projects.clear();
});

async function createProject(files: Record<string, string>): Promise<Project> {
	const root = await mkdtemp(join(tmpdir(), "myharness-phase6-lightweight-"));
	const agentDir = await mkdtemp(join(tmpdir(), "myharness-phase6-lightweight-agent-"));
	projects.add({ root, agentDir });
	for (const [path, content] of Object.entries(files)) {
		const absolutePath = join(root, path);
		await mkdir(join(absolutePath, ".."), { recursive: true });
		await writeFile(absolutePath, content, "utf8");
	}
	return { root, agentDir };
}

function namePathTarget(namePath: string, path?: string) {
	return { type: "name_path" as const, namePath, path };
}

describe("LightweightCodeIntelligenceBackend", () => {
	it("converts legacy symbols without fabricating precise ranges", async () => {
		const project = await createProject({
			"src/service.ts": "export class UserService {\n  run() {}\n}\n",
		});
		const backend = new LightweightCodeIntelligenceBackend({
			workspaceRoot: project.root,
			agentDir: project.agentDir,
		});
		const result = await backend.findSymbol({ query: "run", exact: true });

		expect(result.meta.source).toBe("lightweight");
		expect(result.items[0]).toMatchObject({
			name: "run",
			namePath: "UserService/run",
			path: "src/service.ts",
			line: 1,
			parentNamePath: "UserService",
		});
		expect(result.items[0]?.selectionRange).toBeUndefined();
		expect(result.items[0]?.bodyRange).toBeUndefined();
	});

	it("keeps file symbols as conservative flat roots", async () => {
		const project = await createProject({ "src/service.ts": "class UserService {\n  run() {}\n}\n" });
		const backend = new LightweightCodeIntelligenceBackend({
			workspaceRoot: project.root,
			agentDir: project.agentDir,
		});
		const result = await backend.fileSymbols("src/service.ts");

		expect(result.items.length).toBeGreaterThanOrEqual(2);
		expect(result.items.every((node) => node.children.length === 0)).toBe(true);
		expect(result.items.find((node) => node.symbol.name === "run")?.symbol.parentNamePath).toBe("UserService");
	});

	it("resolves name_path definitions without mixing same-named parents", async () => {
		const project = await createProject({
			"src/services.ts": "class A {\n  run() {}\n}\nclass B {\n  run() {}\n}\n",
		});
		const backend = new LightweightCodeIntelligenceBackend({
			workspaceRoot: project.root,
			agentDir: project.agentDir,
		});
		const result = await backend.findDefinition(namePathTarget("A/run"));

		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.namePath).toBe("A/run");
	});

	it("returns lexical references with 0-based line-only locations and a warning", async () => {
		const project = await createProject({
			"src/service.ts": "class A {\n  run() {}\n}\nconst value = run();\n",
		});
		const backend = new LightweightCodeIntelligenceBackend({
			workspaceRoot: project.root,
			agentDir: project.agentDir,
		});
		const result = await backend.findReferences(namePathTarget("A/run"));

		expect(result.items.length).toBeGreaterThan(0);
		expect(result.items.some((item) => item.location.line === 1)).toBe(true);
		expect(result.items.every((item) => item.location.range === undefined)).toBe(true);
		expect(result.items.every((item) => item.targetSymbolId === undefined && item.targetNamePath === undefined)).toBe(
			true,
		);
		expect(result.meta.warnings?.some((warning) => warning.includes("lexical"))).toBe(true);
	});

	it("marks requested result truncation partial", async () => {
		const files = Object.fromEntries(
			Array.from({ length: 3 }, (_, index) => [`src/file-${index}.ts`, `function run${index}() {}\n`]),
		);
		const project = await createProject(files);
		const backend = new LightweightCodeIntelligenceBackend({
			workspaceRoot: project.root,
			agentDir: project.agentDir,
		});
		const result = await backend.findSymbol({ query: "run", limit: 1 });

		expect(result.items).toHaveLength(1);
		expect(result.meta.completeness).toBe("partial");
		expect(result.meta.warnings?.some((warning) => warning.includes("requested limit"))).toBe(true);
	});

	it("marks a limited refresh partial", async () => {
		const project = await createProject({
			"src/a.ts": "function alpha() {}\n",
			"src/b.ts": "function beta() {}\n",
		});
		const index = new CodeSymbolIndex({ cwd: project.root, agentDir: project.agentDir, maxFiles: 1 });
		const backend = new LightweightCodeIntelligenceBackend({ workspaceRoot: project.root, index });
		const result = await backend.findSymbol({ query: "a" });

		expect(result.meta.completeness).toBe("partial");
		expect(result.meta.warnings?.some((warning) => warning.includes("refresh"))).toBe(true);
	});

	it("keeps 100 concurrent lightweight queries consistent", async () => {
		const project = await createProject({ "src/service.ts": "export function run() {}\n" });
		const backend = new LightweightCodeIntelligenceBackend({
			workspaceRoot: project.root,
			agentDir: project.agentDir,
		});
		const results = await Promise.all(
			Array.from({ length: 100 }, () => backend.findSymbol({ query: "run", exact: true })),
		);

		expect(results.every((result) => result.items.length === 1)).toBe(true);
		expect(new Set(results.map((result) => result.items[0]?.id)).size).toBe(1);
	});
});
