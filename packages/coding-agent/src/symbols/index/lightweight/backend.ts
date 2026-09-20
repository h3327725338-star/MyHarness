import { convertLegacyReference, convertLegacySymbols } from "../../legacy-adapter.ts";
import { normalizeWorkspaceRoot } from "../../lsp/language-server/manager.ts";
import { isInsideWorkspace, normalizeDocumentPath, relativeToWorkspace } from "../../path-semantics.ts";
import { parseNamePath } from "../../symbol-identity.ts";
import type {
	CodeSymbol,
	CodeSymbolTreeNode,
	DefinitionResult,
	FileSymbolsResult,
	ReferencesResult,
	ResultCompleteness,
	SymbolQuery,
	SymbolSearchResult,
	SymbolTarget,
} from "../../types.ts";
import { type CodeQueryOptions, CodeSymbolIndex } from "../code-index.ts";
import { LightweightBackendError, LightweightUnsupportedTargetError } from "./errors.ts";
import type {
	LightweightBackendApi,
	LightweightBackendOptions,
	LightweightIndexPort,
	LightweightQueryOptions,
} from "./types.ts";

const DEFAULT_QUERY_LIMIT = 100;
const INDEX_QUERY_LIMIT = Infinity; // result limit is unlimited by default

interface PreparedQuery {
	readonly refreshLimited: boolean;
	readonly warnings: readonly string[];
}

interface LimitedItems<T> {
	readonly items: T[];
	readonly limited: boolean;
}

function uniqueWarnings(warnings: readonly string[]): string[] {
	return [...new Set(warnings)];
}

function normalizeQueryLimit(value: number | undefined): number {
	if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
		throw new LightweightBackendError("invalid_query", "query limit must be a finite non-negative number");
	}
	return Math.max(1, Math.min(Math.floor(value ?? DEFAULT_QUERY_LIMIT), INDEX_QUERY_LIMIT));
}

function applyLimit<T>(items: readonly T[], limit: number): LimitedItems<T> {
	return items.length > limit
		? { items: [...items.slice(0, limit)], limited: true }
		: { items: [...items], limited: false };
}

function pathMatches(workspaceRoot: string, candidate: string, filter: string | undefined): boolean {
	if (!filter) return true;
	const candidatePath = normalizeDocumentPath(candidate, workspaceRoot);
	const filterPath = normalizeDocumentPath(filter, workspaceRoot);
	return isInsideWorkspace(filterPath, candidatePath);
}

function normalizePathFilter(workspaceRoot: string, value: string | undefined, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (value.trim() === "") throw new LightweightBackendError("invalid_query", `${label} must not be empty`);
	const absolutePath = normalizeDocumentPath(value, workspaceRoot);
	const relativePath = relativeToWorkspace(workspaceRoot, absolutePath);
	if (relativePath === "" || !isInsideWorkspace(workspaceRoot, absolutePath)) {
		throw new LightweightBackendError("invalid_query", `${label} must be inside the workspace root`);
	}
	return relativePath;
}

function lastNamePathComponent(namePath: string): { name: string; hasUnsupportedPrecision: boolean } {
	const parsed = parseNamePath(namePath);
	const name = parsed.components.at(-1) ?? "";
	return {
		name,
		hasUnsupportedPrecision: parsed.components.length > 2 || parsed.overloadIndex !== undefined,
	};
}

function lightweightMeta(
	completeness: ResultCompleteness,
	warnings: readonly string[],
): { source: "lightweight"; completeness: ResultCompleteness; warnings?: string[] } {
	const stableWarnings = uniqueWarnings(warnings);
	return stableWarnings.length > 0
		? { source: "lightweight", completeness, warnings: stableWarnings }
		: { source: "lightweight", completeness };
}

function makeFileSymbols(items: readonly CodeSymbol[]): CodeSymbolTreeNode[] {
	return items.map((symbol) => ({ symbol, children: [] }));
}

export class LightweightCodeIntelligenceBackend implements LightweightBackendApi {
	readonly workspaceRoot: string;
	private readonly index: LightweightIndexPort;

	constructor(options: LightweightBackendOptions) {
		this.workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot);
		this.index = options.index ?? new CodeSymbolIndex({ cwd: this.workspaceRoot, agentDir: options.agentDir });
	}

	async findSymbol(query: SymbolQuery, options: LightweightQueryOptions = {}): Promise<SymbolSearchResult> {
		const prepared = await this.prepare(options.signal);
		const searchText = query.query?.trim() || (query.namePath ? lastNamePathComponent(query.namePath).name : "");
		const pathFilter = normalizePathFilter(this.workspaceRoot, query.path, "symbol query path");
		const limit = normalizeQueryLimit(query.limit);
		if (!searchText) {
			return {
				items: [],
				meta: lightweightMeta(prepared.refreshLimited ? "partial" : "complete", prepared.warnings),
			};
		}

		const raw = await this.index.findSymbol(searchText, this.indexOptions(pathFilter, options.signal));
		const converted = convertLegacySymbols(raw).filter((symbol) => {
			if (!pathMatches(this.workspaceRoot, symbol.path, pathFilter)) return false;
			if (query.exact && symbol.name !== searchText) return false;
			if (query.namePath !== undefined && symbol.namePath !== query.namePath) return false;
			return query.kinds === undefined || query.kinds.includes(symbol.kind);
		});
		const limited = applyLimit(converted, limit);
		const warnings = [...prepared.warnings];
		if (limited.limited) warnings.push("lightweight symbol query was truncated by the requested limit");
		return {
			items: limited.items,
			meta: lightweightMeta(prepared.refreshLimited || limited.limited ? "partial" : "complete", warnings),
		};
	}

	async fileSymbols(filePath: string, options: LightweightQueryOptions = {}): Promise<FileSymbolsResult> {
		const prepared = await this.prepare(options.signal);
		const normalizedPath = normalizePathFilter(this.workspaceRoot, filePath, "file symbols path");
		const raw = await this.index.listFileSymbols(normalizedPath!, this.indexOptions(normalizedPath, options.signal));
		const symbols = convertLegacySymbols(raw);
		const warnings = [...prepared.warnings];
		const limited = makeFileSymbols(symbols);
		return {
			items: limited,
			meta: lightweightMeta(prepared.refreshLimited ? "partial" : "complete", warnings),
		};
	}

	async findDefinition(target: SymbolTarget, options: LightweightQueryOptions = {}): Promise<DefinitionResult> {
		if (target.type !== "name_path") throw new LightweightUnsupportedTargetError("definition", target.type);
		const prepared = await this.prepare(options.signal);
		const pathFilter = normalizePathFilter(this.workspaceRoot, target.path, "definition target path");
		const targetName = lastNamePathComponent(target.namePath);
		if (!targetName.name) throw new LightweightBackendError("invalid_query", "definition namePath must not be empty");
		const raw = await this.index.findDefinition(targetName.name, this.indexOptions(pathFilter, options.signal));
		const converted = convertLegacySymbols(raw).filter(
			(symbol) => pathMatches(this.workspaceRoot, symbol.path, pathFilter) && symbol.namePath === target.namePath,
		);
		const limited = applyLimit(converted, normalizeQueryLimit(options.limit));
		const warnings = [...prepared.warnings];
		if (limited.limited) warnings.push("lightweight definition query was truncated by the default result limit");
		if (targetName.hasUnsupportedPrecision) {
			warnings.push("legacy index cannot represent the complete definition namePath precisely");
		}
		return {
			items: limited.items,
			meta: lightweightMeta(
				prepared.refreshLimited || limited.limited || targetName.hasUnsupportedPrecision ? "partial" : "complete",
				warnings,
			),
		};
	}

	async findReferences(target: SymbolTarget, options: LightweightQueryOptions = {}): Promise<ReferencesResult> {
		if (target.type !== "name_path") throw new LightweightUnsupportedTargetError("references", target.type);
		const prepared = await this.prepare(options.signal);
		const pathFilter = normalizePathFilter(this.workspaceRoot, target.path, "references target path");
		const targetName = lastNamePathComponent(target.namePath);
		if (!targetName.name) throw new LightweightBackendError("invalid_query", "references namePath must not be empty");
		const raw = await this.index.findReferences(targetName.name, this.indexOptions(pathFilter, options.signal));
		const converted = raw
			.filter((reference) => pathMatches(this.workspaceRoot, reference.path, pathFilter))
			.map((reference) => convertLegacyReference(reference));
		const limited = applyLimit(converted, normalizeQueryLimit(options.limit));
		const warnings = [
			...prepared.warnings,
			"reference matching is lexical and cannot prove exact semantic target identity",
		];
		if (limited.limited) warnings.push("lightweight references were truncated by the default result limit");
		if (targetName.hasUnsupportedPrecision) {
			warnings.push("legacy index cannot represent the complete reference namePath precisely");
		}
		return {
			items: limited.items,
			meta: lightweightMeta(prepared.refreshLimited || limited.limited ? "partial" : "complete", warnings),
		};
	}

	private async prepare(signal: AbortSignal | undefined): Promise<PreparedQuery> {
		const refresh = await this.index.ensureFresh(signal);
		return {
			refreshLimited: refresh.limited,
			warnings: refresh.limited ? ["lightweight index refresh was limited; results may be incomplete"] : [],
		};
	}

	private indexOptions(path: string | undefined, signal: AbortSignal | undefined): CodeQueryOptions {
		return { path, limit: INDEX_QUERY_LIMIT, signal, skipRefresh: true };
	}
}
