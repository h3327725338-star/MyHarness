import { stat } from "node:fs/promises";

import type { CodeIntelligenceRouterApi, CodeIntelligenceRoutingOptions } from "../index/router/types.ts";
import { getDocumentIdentity, normalizeDocumentPath } from "../path-semantics.ts";
import type { CodeSymbol, CodeSymbolTreeNode, FileSymbolsResult } from "../types.ts";

/**
 * Everything a workflow operation needs from its session: the router of the
 * session's own workspace, the languages that have a language server
 * registered, and cancellation. One context belongs to one workspace; the
 * caches below never cross workspaces.
 */
export interface WorkflowContext {
	readonly workspaceRoot: string;
	readonly router: CodeIntelligenceRouterApi;
	/** Languages with at least one registered language server (not necessarily running). */
	readonly semanticLanguages: () => ReadonlySet<string>;
	readonly fileSymbols: FileSymbolCache;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export function routingOptions(
	context: WorkflowContext,
	extra: CodeIntelligenceRoutingOptions = {},
): CodeIntelligenceRoutingOptions {
	return {
		...(context.signal ? { signal: context.signal } : {}),
		...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
		...extra,
	};
}

export function flattenSymbolTree(nodes: readonly CodeSymbolTreeNode[]): CodeSymbol[] {
	const output: CodeSymbol[] = [];
	const visit = (node: CodeSymbolTreeNode): void => {
		output.push(node.symbol);
		for (const child of node.children) visit(child);
	};
	for (const node of nodes) visit(node);
	return output;
}

interface CachedFileSymbols {
	readonly mtimeMs: number;
	readonly size: number;
	readonly result: FileSymbolsResult;
}

/**
 * Document symbols per file, reused only while the file's size and
 * modification time are unchanged. Every lookup stats the file first, so an
 * edit by any tool, an editor or Git invalidates the entry before it can be
 * served; deleted files drop out. The language server stays the source of
 * truth: a miss asks it again, after the backend has re-synchronized the file
 * from disk.
 */
export class FileSymbolCache {
	private readonly entries = new Map<string, CachedFileSymbols>();
	private readonly maxEntries: number;

	constructor(maxEntries = 2_000) {
		this.maxEntries = maxEntries;
	}

	async get(
		workspaceRoot: string,
		router: CodeIntelligenceRouterApi,
		path: string,
		options: CodeIntelligenceRoutingOptions,
	): Promise<FileSymbolsResult> {
		options.signal?.throwIfAborted();
		const absolutePath = normalizeDocumentPath(path, workspaceRoot);
		const key = getDocumentIdentity(absolutePath, workspaceRoot);
		let info: { mtimeMs: number; size: number } | undefined;
		try {
			const stats = await stat(absolutePath);
			info = { mtimeMs: stats.mtimeMs, size: stats.size };
		} catch {
			this.entries.delete(key);
		}
		options.signal?.throwIfAborted();
		const cached = this.entries.get(key);
		if (cached && info && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
			this.entries.delete(key);
			this.entries.set(key, cached);
			return cached.result;
		}
		options.signal?.throwIfAborted();
		const result = await router.fileSymbols(path, options);
		options.signal?.throwIfAborted();
		// A partial answer (server still loading, fallback) is not worth keeping.
		if (info && result.meta.completeness === "complete") {
			this.entries.delete(key);
			this.entries.set(key, { ...info, result });
			while (this.entries.size > this.maxEntries) {
				const oldest = this.entries.keys().next();
				if (oldest.done) break;
				this.entries.delete(oldest.value);
			}
		}
		return result;
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}
