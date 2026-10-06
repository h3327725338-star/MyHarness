import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChangeGate, ChangeGateInput, ChangeGateVerdict } from "../../changes/service.ts";
import { sha256 } from "../../changes/text-file.ts";
import {
	continueInspect,
	decodeContinuation,
	type InspectFacetName,
	inspectSymbol,
} from "../inspect/inspect-symbol.ts";
import { samePath } from "../path-semantics.ts";
import type { CodeCallEdge, CodeReference, CodeSymbol, CodeSymbolTreeNode } from "../types.ts";
import type { CodeSymbolIndex } from "./code-index.ts";
import type { CodeIntelligenceRouterAdvancedApi } from "./router/types.ts";

/** Runtime evidence, not a proof of business correctness or dynamic/external consumer coverage. */
export class ImpactCoverageGate implements ChangeGate {
	readonly name = "semantic-impact-coverage-v1";
	readonly recheckAfterApproval = true;
	private readonly index: CodeSymbolIndex;
	private readonly router: CodeIntelligenceRouterAdvancedApi;
	private readonly root: string;
	constructor(index: CodeSymbolIndex, router: CodeIntelligenceRouterAdvancedApi, root: string) {
		this.index = index;
		this.router = router;
		this.root = root;
	}
	async check(input: ChangeGateInput): Promise<ChangeGateVerdict> {
		if (input.mode !== "strict") return { allow: true };
		const refuse = (message: string): ChangeGateVerdict => ({ allow: false, code: "PERMIT_REQUIRED", message });
		const plan = input.impactPlan;
		if (input.changeset.files.some((file) => file.operation === "create"))
			return refuse(
				"New declarations require a proposed-source impact adapter; existing-source references cannot establish their coverage",
			);
		if (!plan) return refuse("Strict impact analysis requires a preview-bound review before querying relations");
		await this.index.ensureFresh(input.signal);
		const before = this.index.getWorkspaceFacts();
		const markerSnapshot = async () =>
			Promise.all(
				before.markers.map(async (path) => ({ path, hash: sha256(await readFile(resolve(this.root, path))) })),
			);
		const markerHashes = await markerSnapshot();
		if (!before.complete)
			return refuse("Impact inventory is incomplete; semantic coverage cannot authorize this change");
		const decisions = new Set(
			plan.affected.filter((item) => item.disposition !== "external").map((item) => item.path),
		);
		const queried = new Set<string>();
		const semanticConsumerPaths = new Set<string>();
		let count = 0;
		const queries: unknown[] = [];
		const deadline = Date.now() + 120000;
		const walk = (nodes: readonly CodeSymbolTreeNode[]): CodeSymbolTreeNode[] =>
			nodes.flatMap((node) => [node, ...walk(node.children)]);
		try {
			for (const path of new Set([
				...plan.rootPaths,
				...input.changeset.files.filter((file) => file.operation !== "create").map((file) => file.path),
			])) {
				const symbols = await this.router.fileSymbols(path, {
					mode: "semantic",
					timeoutMs: 30000,
					signal: input.signal,
				});
				if (symbols.meta.source !== "semantic" || symbols.meta.completeness !== "complete" || symbols.meta.fallback)
					return refuse(`Incomplete semantic declaration coverage: ${path}`);
				const declarations = walk(symbols.items);
				if (!declarations.length && !(input.changeset.source === "rename" && semanticConsumerPaths.has(path)))
					return refuse(
						`No semantic declarations in ${path}; data/configuration changes require a dedicated impact adapter`,
					);
				for (const { symbol } of declarations) {
					if (!symbol.selectionRange) return refuse(`No precise declaration position for ${path}: ${symbol.name}`);
					input.signal?.throwIfAborted();
					if (++count > 100 || Date.now() >= deadline)
						return refuse("Impact declaration query budget exceeded; reduce the reviewed change scope");
					const references = await this.router.findReferences(
						{ type: "position", path, position: symbol.selectionRange.start },
						{ mode: "semantic", includeDeclaration: true, timeoutMs: 30000, limit: 500, signal: input.signal },
					);
					if (
						references.meta.source !== "semantic" ||
						references.meta.completeness !== "complete" ||
						references.meta.fallback
					)
						return refuse(`Incomplete semantic reference coverage: ${path}: ${symbol.name}`);
					const textCandidates = await this.index.searchCode(symbol.name, { limit: 500, ignoreCase: false });
					if (textCandidates.length >= 500)
						return refuse(
							`Text candidate budget exceeded for ${symbol.name}; dynamic/string coverage is unknown`,
						);
					for (const candidate of textCandidates) {
						if (!decisions.has(candidate.path))
							return refuse(
								`Impact review omits lexical/string candidate ${candidate.path} for ${symbol.name}; classify it separately from semantic references`,
							);
					}
					queries.push({
						relation: "lexical-candidates",
						path,
						name: symbol.name,
						candidates: textCandidates,
						semantic: false,
					});
					queries.push({
						path,
						name: symbol.name,
						position: symbol.selectionRange.start,
						relation: "references",
						meta: references.meta,
						consumers: references.items.map((item) => item.location.path),
					});
					queried.add(path);
					const facets: InspectFacetName[] = [];
					if (["function", "method", "constructor"].includes(symbol.kind))
						facets.push("incoming_calls", "outgoing_calls");
					if (["class", "interface", "struct", "trait"].includes(symbol.kind))
						facets.push("implementations", "supertypes", "subtypes");
					if (symbol.kind === "method") facets.push("implementations");
					if (facets.length) {
						let inspected = await inspectSymbol(this.router, {
							target: { type: "position", path, position: symbol.selectionRange.start },
							facets,
							pageSize: 100,
							routing: {
								mode: "semantic",
								signal: input.signal,
								timeoutMs: Math.max(1, Math.min(30000, deadline - Date.now())),
							},
						});
						for (const initial of inspected.facets) {
							let facet = initial;
							for (;;) {
								const externalWarnings = facet.meta?.warnings ?? [];
								const externalAccounted =
									facet.meta?.completeness === "partial" &&
									externalWarnings.length > 0 &&
									externalWarnings.every((warning) => {
										const prefix = "skipped location outside workspace: ";
										if (!warning.startsWith(prefix)) return false;
										return plan.affected.some((item) => {
											if (item.disposition !== "external") return false;
											try {
												return samePath(
													fileURLToPath(item.path),
													fileURLToPath(warning.slice(prefix.length)),
												);
											} catch {
												return false;
											}
										});
									});
								if (
									!["ok", "empty"].includes(facet.status) ||
									facet.meta?.source !== "semantic" ||
									(facet.meta.completeness !== "complete" && !externalAccounted) ||
									facet.meta.fallback
								)
									return refuse(
										`Incomplete ${facet.name} coverage: ${path}: ${symbol.name} (${facet.reason ?? JSON.stringify(facet.meta) ?? facet.status})`,
									);
								queries.push({
									path,
									name: symbol.name,
									relation: facet.name,
									status: facet.status,
									meta: facet.meta,
									offset: facet.offset,
									total: facet.total,
									items: facet.items,
								});
								for (const item of facet.items) {
									const relatedPath =
										"symbol" in item
											? (item as CodeCallEdge).symbol.path
											: "path" in item
												? (item as CodeSymbol).path
												: (item as CodeReference).location.path;
									if (!decisions.has(relatedPath))
										return refuse(
											`Impact review omits ${facet.name} relation in ${relatedPath} of ${path}: ${symbol.name}`,
										);
								}
								if (!facet.continuation) break;
								if (Date.now() >= deadline) return refuse("Impact relationship paging budget exceeded");
								inspected = await continueInspect(
									this.router,
									decodeContinuation(facet.continuation, input.signal),
								);
								facet = inspected.facets[0]!;
							}
						}
					}
					for (const reference of references.items) {
						semanticConsumerPaths.add(reference.location.path);
						if (!decisions.has(reference.location.path))
							return refuse(
								`Impact review omits semantic consumer ${reference.location.path} of ${path}: ${symbol.name}`,
							);
					}
				}
			}
		} catch (error) {
			input.signal?.throwIfAborted();
			return refuse(`Impact semantic query is blocked: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!count)
			return refuse(
				"No semantic declarations were inspected; configuration/data changes need a dedicated impact adapter",
			);
		for (const path of queried) {
			const expected = before.files.find((file) => file.path === path);
			if (!expected || sha256(await readFile(resolve(this.root, path), "utf8")) !== expected.hash)
				return refuse(`Impact source changed while querying: ${path}`);
		}
		await this.index.ensureFresh(input.signal);
		const after = this.index.getWorkspaceFacts();
		const snapshot = (facts: typeof before) =>
			JSON.stringify({
				files: [...facts.files].sort((a, b) => a.path.localeCompare(b.path)),
				markers: [...facts.markers].sort(),
				complete: facts.complete,
			});
		if (
			snapshot(before) !== snapshot(after) ||
			JSON.stringify(markerHashes) !== JSON.stringify(await markerSnapshot())
		)
			return refuse("Workspace changed during semantic impact analysis; repeat the review");
		return {
			allow: true,
			evidence: {
				snapshot: sha256(snapshot(after) + JSON.stringify(markerHashes)),
				queries,
				queriedAt: Date.now(),
				reviewHash: sha256(JSON.stringify(plan)),
				limitations: [
					"Dynamic and external business semantics are not proved",
					"Only the current index inventory and queried declarations are covered",
				],
			},
		};
	}
}
