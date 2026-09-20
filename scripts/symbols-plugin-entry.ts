import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSymbolsToolDefinition } from "../packages/coding-agent/src/tools/symbols.ts";
import { CodeIntelligenceRuntime } from "../packages/coding-agent/src/symbols/runtime/runtime.ts";
import { CodeIntelligenceInstallationManager } from "../packages/coding-agent/src/symbols/runtime/installation.ts";
import { getWorkspaceIdentity, normalizeWorkspaceRoot } from "../packages/coding-agent/src/symbols/path-semantics.ts";
import type { CodeIntelligenceRuntimeStatus } from "../packages/coding-agent/src/symbols/runtime/types.ts";

const MAX_MCP_TEXT_CHARS = 300_000;
const MAX_RUNTIME_STATES = 8;

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(runtimeDirectory, "..");
const installationManager = new CodeIntelligenceInstallationManager();
const SERVER_VERSION = installationManager.manifest.releaseVersion;
const SERVER_CATALOG = installationManager.manifest.modules.map((entry) => ({
	id: `managed-${entry.id}`,
	moduleId: entry.id,
	key: entry.serverKey,
	languages: entry.languages,
	server: entry.label,
	version: entry.serverVersion,
	license: "See packages/coding-agent/code-intelligence/licenses",
	distribution: entry.availability ? "external-prerequisites-required" : "optional-download",
	notes: entry.notes,
}));
const languageIds = Object.freeze([...new Set(SERVER_CATALOG.flatMap((entry) => entry.languages))].sort());

function dataRoot(): string {
	const explicit = process.env.MYHARNESS_SYMBOLS_DATA_DIR?.trim();
	if (explicit) return path.resolve(explicit);
	return installationManager.getWorkspaceDataRoot(pluginRoot);
}

const persistentDataRoot = dataRoot();
const indexAgentDir = path.join(persistentDataRoot, "index");

function serverAvailable(entry: (typeof SERVER_CATALOG)[number]): boolean {
	const status = installationManager.getModuleStatus(entry.moduleId);
	return status.status === "installed" || status.status === "update-available";
}

interface RuntimeState {
	readonly root: string;
	readonly runtime: CodeIntelligenceRuntime;
	readonly tool: ReturnType<typeof createSymbolsToolDefinition>;
	readonly createdAt: number;
}

const runtimeStates = new Map<string, RuntimeState>();

async function createRuntimeState(rootInput: string): Promise<RuntimeState> {
	const root = normalizeWorkspaceRoot(rootInput);
	const runtime = new CodeIntelligenceRuntime({
		workspaceRoot: root,
		agentDir: indexAgentDir,
		installationManager,
		registry: installationManager.createInstalledLanguageServerRegistry({ enabled: true }, persistentDataRoot),
		semanticEnabled: true,
		maxSymbolStoreEntries: 10_000,
	});
	return {
		root,
		runtime,
		tool: createSymbolsToolDefinition(root, { codeIntelligence: runtime.services }),
		createdAt: Date.now(),
	};
}

async function getRuntimeState(rootInput: string): Promise<RuntimeState> {
	const root = normalizeWorkspaceRoot(rootInput);
	const key = getWorkspaceIdentity(root);
	const existing = runtimeStates.get(key);
	if (existing) return existing;
	const state = await createRuntimeState(root);
	runtimeStates.set(key, state);
	if (runtimeStates.size > MAX_RUNTIME_STATES) {
		const oldest = [...runtimeStates.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
		if (oldest && oldest[0] !== key) {
			runtimeStates.delete(oldest[0]);
			await oldest[1].runtime.dispose().catch(() => undefined);
		}
	}
	return state;
}

function filePathFromUri(uri: unknown): string | undefined {
	if (typeof uri !== "string" || !/^file:/iu.test(uri)) return undefined;
	try {
		return fileURLToPath(uri);
	} catch {
		return undefined;
	}
}

function initializeRoot(params: unknown): string | undefined {
	const value = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
	if (Array.isArray(value.roots)) {
		for (const root of value.roots) {
			const candidate = filePathFromUri(root && typeof root === "object" ? (root as Record<string, unknown>).uri : undefined);
			if (candidate) return candidate;
		}
	}
	return filePathFromUri(value.rootUri);
}

let negotiatedWorkspaceRoot: string | undefined;

function requestedWorkspaceRoot(args: Record<string, unknown>, operation: string): string {
	const requested =
		typeof args.workspaceRoot === "string" && args.workspaceRoot.trim()
			? args.workspaceRoot
			: negotiatedWorkspaceRoot || process.env.CODEX_WORKSPACE_ROOT || process.env.CODEX_SYMBOLS_ROOT;
	if (!requested) {
		const error = new Error(
			`workspaceRoot is required for project-scoped Symbols operation "${operation}"; pass an absolute project root`,
		);
		(error as Error & { code?: string }).code = "WORKSPACE_ROOT_REQUIRED";
		throw error;
	}
	return requested;
}

function statusWorkspaceRoot(args: Record<string, unknown>): string {
	const requested =
		typeof args.workspaceRoot === "string" && args.workspaceRoot.trim()
			? args.workspaceRoot
			: negotiatedWorkspaceRoot || process.env.CODEX_WORKSPACE_ROOT || process.env.CODEX_SYMBOLS_ROOT;
	return requested || pluginRoot;
}

function errorChain(error: unknown): unknown[] {
	const values: unknown[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current && !seen.has(current)) {
		values.push(current);
		seen.add(current);
		current = current instanceof Error ? current.cause : undefined;
	}
	return values;
}

function errorSummary(error: unknown, operation: unknown): Record<string, unknown> {
	const chain = errorChain(error);
	const first = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
	const code = typeof first.code === "string" ? first.code : undefined;
	const message = error instanceof Error ? error.message : String(error);
	const details: Record<string, string> = {};
	for (const key of ["definitionId", "workspaceRoot", "language", "filePath", "capability", "method"]) {
		if (typeof first[key] === "string") details[key] = first[key] as string;
	}
	const causeCodes = chain
		.map((value) => (value && typeof value === "object" ? (value as Record<string, unknown>).code : undefined))
		.filter((value): value is string => typeof value === "string");
	if (causeCodes.length > 0) details.causeCode = causeCodes[0];
	return {
		code: code || (message.includes("workspaceRoot") ? "WORKSPACE_ROOT_REQUIRED" : "SYMBOLS_OPERATION_FAILED"),
		message,
		operation: typeof operation === "string" ? operation : undefined,
		details,
	};
}

function augmentSchema(baseSchema: unknown): Record<string, unknown> {
	const schema = structuredClone(baseSchema) as Record<string, unknown>;
	const branches = Array.isArray(schema.anyOf) ? schema.anyOf : [schema];
	for (const branch of branches) {
		if (!branch || typeof branch !== "object") continue;
		const record = branch as Record<string, unknown>;
		const properties =
			record.properties && typeof record.properties === "object"
				? (record.properties as Record<string, unknown>)
				: {};
		properties.workspaceRoot = {
			type: "string",
			description:
				"Absolute workspace root. Required for project operations unless the MCP host supplied a root through initialize or CODEX_WORKSPACE_ROOT.",
		};
		record.properties = properties;
	}
	return schema;
}

function catalogStatus(status: CodeIntelligenceRuntimeStatus): Record<string, unknown> {
	const active = new Map(status.languageServers.map((server) => [server.definitionId, server]));
	const languages = SERVER_CATALOG.flatMap((entry) =>
		entry.languages.map((language) => {
			const server = active.get(entry.id);
			return {
				language,
				server: entry.server,
				serverId: entry.id,
				version: entry.version,
				license: entry.license,
				distribution: entry.distribution,
				installed: serverAvailable(entry),
				registered: Boolean(server),
				state: server?.state || "not-registered",
				discovered: server?.discovered ?? false,
				running: server?.running ?? false,
				...(entry.notes ? { notes: entry.notes } : {}),
			};
		}),
	);
	return {
		pluginRoot,
		installation: {
			storePath: installationManager.storeDir,
			manifestVersion: installationManager.manifest.releaseVersion,
			published: installationManager.manifest.published,
			defaultMode: installationManager.manifest.defaultMode,
		},
		dataRoot: persistentDataRoot,
		globalLanguageServerFallback: false,
		languageIds,
		languages,
	};
}

function textContent(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type?: unknown; text?: unknown } => Boolean(item && typeof item === "object"))
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text as string)
		.join("\n");
}

async function callSymbols(rawArguments: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
	const args = rawArguments && typeof rawArguments === "object" ? { ...(rawArguments as Record<string, unknown>) } : {};
	const operation = typeof args.operation === "string" ? args.operation : "";
	const root = operation === "status" ? statusWorkspaceRoot(args) : requestedWorkspaceRoot(args, operation);
	const state = await getRuntimeState(root);
	delete args.workspaceRoot;
	const result = await state.tool.execute(`mcp-${Date.now()}`, args as never, signal);
	const originalText = textContent(result);
	const runtimeStatus = state.runtime.getStatus();
	const plugin = catalogStatus(runtimeStatus);
	const text =
		operation === "status"
			? `${originalText}\n[plugin_runtime]\n${JSON.stringify(plugin, null, 2)}`
			: originalText;
	return {
		operation,
		workspaceRoot: state.root,
		text,
		details: result.details,
		...(operation === "status" ? { plugin } : {}),
	};
}

function writeMessage(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function resultFor(id: unknown, result: unknown): void {
	writeMessage({ jsonrpc: "2.0", id, result: result as Record<string, unknown> });
}

const bootstrapTool = createSymbolsToolDefinition(pluginRoot);
const tool = {
	name: "symbols",
	description:
		"Use for code structure and semantic navigation: workspace/file symbols, definitions, references, implementations, hover/type information, diagnostics, callers/callees, type hierarchies, and code maps. Call status first when backend availability matters. Use read to inspect source text, search_code only for plain-text matching, and do not treat lightweight/fallback results as semantic proof. Project operations require workspaceRoot unless the host supplied a root during MCP initialize.",
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	inputSchema: augmentSchema(bootstrapTool.parameters),
};

const controllers = new Map<string, AbortController>();
let shutdownPromise: Promise<void> | undefined;

async function shutdown(): Promise<void> {
	if (shutdownPromise) return shutdownPromise;
	shutdownPromise = (async () => {
		await Promise.all([...runtimeStates.values()].map((state) => state.runtime.dispose().catch(() => undefined)));
		runtimeStates.clear();
	})();
	return shutdownPromise;
}

function protocolRoot(params: unknown): string | undefined {
	return initializeRoot(params);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
	if (!line.trim()) return;
	void (async () => {
		let request: Record<string, unknown>;
		try {
			request = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		const method = request.method;
		const id = request.id;
		if (method === "notifications/initialized") return;
		if (method === "notifications/cancelled") {
			const params = request.params && typeof request.params === "object" ? (request.params as Record<string, unknown>) : {};
			const requestId = params.requestId ?? params.id;
			if (requestId !== undefined) controllers.get(String(requestId))?.abort();
			return;
		}
		if (method === "initialize") {
			negotiatedWorkspaceRoot = protocolRoot(request.params);
			resultFor(id, {
				protocolVersion: (request.params as Record<string, unknown> | undefined)?.protocolVersion ?? "2024-11-05",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "myharness-symbols", version: SERVER_VERSION },
			});
			return;
		}
		if (method === "tools/list") {
			resultFor(id, { tools: [tool] });
			return;
		}
		if (method === "shutdown") {
			resultFor(id, null);
			await shutdown();
			return;
		}
		if (method === "tools/call") {
			const params = request.params && typeof request.params === "object" ? (request.params as Record<string, unknown>) : {};
			if (params.name !== "symbols") {
				resultFor(id, { isError: true, content: [{ type: "text", text: "unknown tool: symbols" }] });
				return;
			}
			const controller = new AbortController();
			controllers.set(String(id), controller);
			try {
				const value = await callSymbols(params.arguments, controller.signal);
				const serialized = JSON.stringify(value);
				if (serialized.length > MAX_MCP_TEXT_CHARS) {
					resultFor(id, {
						isError: true,
						content: [{ type: "text", text: "Symbols result exceeded the MCP output limit; narrow path or reduce limit." }],
					});
				} else {
					resultFor(id, {
						content: [{ type: "text", text: value.text as string }],
						structuredContent: value,
					});
				}
			} catch (error) {
				const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
				const summary = errorSummary(error, args.operation);
				resultFor(id, {
					isError: true,
					content: [{ type: "text", text: JSON.stringify({ error: summary }, null, 2) }],
					structuredContent: { error: summary },
				});
			} finally {
				controllers.delete(String(id));
			}
			return;
		}
		if (id !== undefined) writeMessage({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(method)}` } });
	})();
});

input.on("close", () => {
	void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
