/**
 * Same-object relationship profile ("inspect_symbol").
 *
 * One target is located once and every relationship facet is asked about that same object: its
 * definition, hover, references, implementations, callers and callees, supertypes and subtypes, and the
 * diagnostics of its file. Each facet carries its own status, so a language server that cannot answer one
 * question (no call hierarchy, no compiler for inheritance) never erases what the others found.
 *
 * Paging: a facet whose list is longer than the page returns a continuation token. The token carries the
 * target, the routing choice and a fingerprint of the facet's items; resuming asks the server again and is
 * refused as `stale` when the answer is no longer the same list. Empty, unsupported, environment_blocked,
 * stale, failed and skipped are different statuses and are never collapsed into an empty list.
 */

import { createHash } from "node:crypto";
import { CodeIntelligenceRouterError } from "../index/router/errors.ts";
import { isAbortError } from "../index/router/policy.ts";
import type { CodeIntelligenceRouterAdvancedApi, CodeIntelligenceRoutingOptions } from "../index/router/types.ts";
import {
	LanguageServerInitializeError,
	LanguageServerStartError,
	LanguageServerUnavailableError,
	NoLanguageServerRegisteredError,
} from "../lsp/language-server/errors.ts";
import { SemanticBackendError, SemanticCapabilityUnsupportedError } from "../semantic/errors.ts";
import type {
	CodeCallEdge,
	CodeDiagnostic,
	CodeHoverInfo,
	CodeLocation,
	CodePosition,
	CodeReference,
	CodeSymbol,
	DefinitionResult,
	IntelligenceResultMeta,
	SymbolTarget,
} from "../types.ts";

export const INSPECT_FACETS = [
	"definition",
	"hover",
	"references",
	"implementations",
	"incoming_calls",
	"outgoing_calls",
	"supertypes",
	"subtypes",
	"diagnostics",
] as const;

export type InspectFacetName = (typeof INSPECT_FACETS)[number];

export type InspectFacetStatus =
	| "ok"
	| "empty"
	| "unsupported"
	| "environment_blocked"
	| "stale"
	| "failed"
	| "skipped";

export type InspectFacetItem = CodeSymbol | CodeReference | CodeCallEdge | CodeHoverInfo | CodeDiagnostic;

export type InspectTarget = Extract<SymbolTarget, { type: "position" | "symbol_id" }>;

export interface InspectFacet {
	readonly name: InspectFacetName;
	readonly status: InspectFacetStatus;
	/** The current page of items. */
	readonly items: readonly InspectFacetItem[];
	/** Number of items in the whole (fetched) list, not only this page. */
	readonly total: number;
	/** Index of the first item of this page within the whole list. */
	readonly offset: number;
	/** Present when more items follow this page. */
	readonly continuation?: string;
	readonly meta?: Pick<
		IntelligenceResultMeta,
		"source" | "completeness" | "warnings" | "fallback" | "provenance" | "coverage" | "hierarchy"
	>;
	/** Why the facet has no items: unsupported capability, missing prerequisite, stale target, failure. */
	readonly reason?: string;
	/** Reference counts per file over the whole list, for facets whose items are locations. */
	readonly byFile?: ReadonlyArray<{ readonly path: string; readonly count: number }>;
}

export interface InspectTargetInfo {
	/** The symbol the target resolves to, when the server or index could identify one. */
	readonly symbol?: CodeSymbol;
	/** The precise position every facet was asked about. */
	readonly position?: { readonly path: string; readonly position: CodePosition };
}

export interface InspectResult {
	readonly target: InspectTargetInfo;
	/** Identity of the inspected object; continuation tokens are bound to it. */
	readonly snapshot: string;
	readonly facets: readonly InspectFacet[];
	/** The symbol_id no longer resolves: no facet was asked. */
	readonly stale?: string;
}

export interface InspectRequest {
	readonly target: InspectTarget;
	/** Defaults to every facet. */
	readonly facets?: readonly InspectFacetName[];
	/** Page size per facet (default 20, at most 100). */
	readonly pageSize?: number;
	readonly routing: CodeIntelligenceRoutingOptions;
}

export interface InspectContinuation {
	readonly request: InspectRequest;
	readonly facet: InspectFacetName;
	readonly offset: number;
	/** Fingerprint of the facet's items when the token was issued. */
	readonly snapshot: string;
}

export const DEFAULT_INSPECT_PAGE_SIZE = 20;
export const MAX_INSPECT_PAGE_SIZE = 100;
/** The most items one facet fetches from the router; beyond it the facet reports itself as partial. */
export const MAX_INSPECT_FACET_ITEMS = 500;
/** Facets that have not started when this much time has passed are reported as skipped. */
export const INSPECT_TOTAL_BUDGET_MS = 120_000;

const TOKEN_VERSION = 1;
const MAX_TOKEN_LENGTH = 4_000;

export class InspectContinuationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InspectContinuationError";
	}
}

function fingerprint(value: string): string {
	return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function positionKey(position: CodePosition | undefined): string {
	return position ? `${position.line}:${position.character}` : "-";
}

function locationKey(location: CodeLocation): string {
	return `${location.path}:${positionKey(location.range?.start)}-${positionKey(location.range?.end)}`;
}

function symbolKey(symbol: CodeSymbol): string {
	return `${symbol.path}:${positionKey(symbol.selectionRange?.start)}:${symbol.kind}:${symbol.namePath}`;
}

function itemKey(facet: InspectFacetName, item: InspectFacetItem): string {
	switch (facet) {
		case "references":
			return locationKey((item as CodeReference).location);
		case "incoming_calls":
		case "outgoing_calls": {
			const edge = item as CodeCallEdge;
			return `${symbolKey(edge.symbol)}|${edge.callSites.map(locationKey).join(",")}`;
		}
		case "hover":
			return JSON.stringify((item as CodeHoverInfo).contents);
		case "diagnostics": {
			const diagnostic = item as CodeDiagnostic;
			return `${locationKey(diagnostic.location)}:${diagnostic.code ?? ""}:${diagnostic.message}`;
		}
		default:
			return symbolKey(item as CodeSymbol);
	}
}

function compareNumbers(left: number | undefined, right: number | undefined): number {
	return (left ?? -1) - (right ?? -1);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareLocations(left: CodeLocation, right: CodeLocation): number {
	if (left.path !== right.path) return compareStrings(left.path, right.path);
	return (
		compareNumbers(left.range?.start.line ?? left.line, right.range?.start.line ?? right.line) ||
		compareNumbers(left.range?.start.character, right.range?.start.character) ||
		compareNumbers(left.range?.end.line, right.range?.end.line) ||
		compareNumbers(left.range?.end.character, right.range?.end.character)
	);
}

function compareSymbols(left: CodeSymbol, right: CodeSymbol): number {
	if (left.path !== right.path) return compareStrings(left.path, right.path);
	return (
		compareNumbers(left.selectionRange?.start.line ?? left.line, right.selectionRange?.start.line ?? right.line) ||
		compareNumbers(left.selectionRange?.start.character, right.selectionRange?.start.character) ||
		compareStrings(left.namePath, right.namePath)
	);
}

function compareItems(facet: InspectFacetName, left: InspectFacetItem, right: InspectFacetItem): number {
	switch (facet) {
		case "references":
			return compareLocations((left as CodeReference).location, (right as CodeReference).location);
		case "incoming_calls":
		case "outgoing_calls":
			return compareSymbols((left as CodeCallEdge).symbol, (right as CodeCallEdge).symbol);
		case "diagnostics": {
			const a = left as CodeDiagnostic;
			const b = right as CodeDiagnostic;
			return compareLocations(a.location, b.location) || compareStrings(a.message, b.message);
		}
		case "hover":
			return 0;
		default:
			return compareSymbols(left as CodeSymbol, right as CodeSymbol);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Only the routing choices travel in a token; never a signal or a limit. */
function encodeContinuation(value: InspectContinuation): string {
	const { request } = value;
	const routing = request.routing;
	const payload = {
		v: TOKEN_VERSION,
		facet: value.facet,
		offset: value.offset,
		snapshot: value.snapshot,
		target: request.target,
		pageSize: request.pageSize,
		routing: {
			mode: routing.mode,
			language: routing.language,
			definitionId: routing.definitionId,
			timeoutMs: routing.timeoutMs,
		},
	};
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeTarget(value: unknown): InspectTarget {
	if (isRecord(value) && value.type === "position") {
		const position = value.position;
		if (
			typeof value.path === "string" &&
			value.path !== "" &&
			isRecord(position) &&
			isNonNegativeInteger(position.line) &&
			isNonNegativeInteger(position.character)
		) {
			return {
				type: "position",
				path: value.path,
				position: { line: position.line, character: position.character },
			};
		}
	}
	if (isRecord(value) && value.type === "symbol_id" && typeof value.symbolId === "string" && value.symbolId !== "") {
		return { type: "symbol_id", symbolId: value.symbolId };
	}
	throw new InspectContinuationError("continuation token carries an invalid target");
}

/** Tokens come from the model: every field is untrusted input and is re-validated. */
export function decodeContinuation(token: string, signal?: AbortSignal): InspectContinuation {
	let parsed: unknown;
	try {
		if (token.length > MAX_TOKEN_LENGTH) throw new Error("too long");
		parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
	} catch {
		throw new InspectContinuationError("continuation token is not valid");
	}
	if (!isRecord(parsed) || parsed.v !== TOKEN_VERSION) {
		throw new InspectContinuationError("continuation token has an unsupported version");
	}
	const { facet, offset, snapshot, pageSize } = parsed;
	if (
		typeof facet !== "string" ||
		!(INSPECT_FACETS as readonly string[]).includes(facet) ||
		!isNonNegativeInteger(offset) ||
		typeof snapshot !== "string" ||
		(pageSize !== undefined && !isNonNegativeInteger(pageSize))
	) {
		throw new InspectContinuationError("continuation token is malformed");
	}
	const routing = isRecord(parsed.routing) ? parsed.routing : {};
	const mode = routing.mode;
	return {
		request: {
			target: decodeTarget(parsed.target),
			pageSize: pageSize as number | undefined,
			routing: {
				mode: mode === "auto" || mode === "semantic" || mode === "lightweight" ? mode : undefined,
				language: typeof routing.language === "string" ? routing.language : undefined,
				definitionId: typeof routing.definitionId === "string" ? routing.definitionId : undefined,
				timeoutMs: typeof routing.timeoutMs === "number" ? routing.timeoutMs : undefined,
				...(signal ? { signal } : {}),
			},
		},
		facet: facet as InspectFacetName,
		offset,
		snapshot,
	};
}

function causeChain(error: unknown): unknown[] {
	const values: unknown[] = [];
	for (let current: unknown = error, depth = 0; current !== undefined && depth < 8; depth++) {
		values.push(current);
		current = current instanceof Error ? current.cause : undefined;
	}
	return values;
}

/** Say why a facet has no answer, distinguishing "cannot" from "not installed" from "broke". */
export function classifyFacetFailure(cause: unknown): { status: InspectFacetStatus; reason: string } {
	const message = (cause instanceof Error ? cause.message : String(cause)).split("\n")[0].slice(0, 300);
	if (cause instanceof CodeIntelligenceRouterError) {
		if (cause.code === "unknown_symbol_id" || cause.code === "stale_symbol_id") {
			return { status: "stale", reason: message };
		}
		if (cause.code === "semantic_backend_unavailable") return { status: "environment_blocked", reason: message };
		if (cause.code === "unsupported_operation" || cause.code === "unsupported_target") {
			return { status: "unsupported", reason: message };
		}
	}
	for (const value of causeChain(cause)) {
		if (value instanceof SemanticCapabilityUnsupportedError) return { status: "unsupported", reason: message };
		if (value instanceof SemanticBackendError) {
			if (value.code === "environment_blocked") return { status: "environment_blocked", reason: message };
			if (value.code === "unsupported_language" || value.code === "unsupported_target") {
				return { status: "unsupported", reason: message };
			}
		}
		if (value instanceof NoLanguageServerRegisteredError || value instanceof LanguageServerUnavailableError) {
			return { status: "environment_blocked", reason: message };
		}
		if (value instanceof LanguageServerInitializeError || value instanceof LanguageServerStartError) {
			return { status: "failed", reason: message };
		}
	}
	return { status: "failed", reason: message };
}

interface FacetFetch {
	readonly items: InspectFacetItem[];
	readonly meta: IntelligenceResultMeta;
}

interface ResolvedTarget {
	readonly info: InspectTargetInfo;
	/** What every facet is asked about; a position whenever the object has a precise range. */
	readonly asked: SymbolTarget;
	readonly filePath: string | undefined;
	/** Routing for the facets: pinned to the server that produced a symbol_id's symbol. */
	readonly routing: CodeIntelligenceRoutingOptions;
	/** Shared by target resolution and the definition facet so the server is asked once. */
	readonly definition: () => Promise<DefinitionResult>;
	readonly stale?: string;
}

function lazy<T>(factory: () => Promise<T>): () => Promise<T> {
	let promise: Promise<T> | undefined;
	return () => {
		promise ??= factory();
		return promise;
	};
}

function pageSizeOf(request: InspectRequest): number {
	const requested = request.pageSize ?? DEFAULT_INSPECT_PAGE_SIZE;
	return Math.min(Math.max(1, Math.floor(requested)), MAX_INSPECT_PAGE_SIZE);
}

function metaOf(meta: IntelligenceResultMeta): NonNullable<InspectFacet["meta"]> {
	return {
		source: meta.source,
		completeness: meta.completeness,
		...(meta.warnings ? { warnings: meta.warnings } : {}),
		...(meta.fallback ? { fallback: meta.fallback } : {}),
		...(meta.provenance ? { provenance: meta.provenance } : {}),
		...(meta.coverage ? { coverage: meta.coverage } : {}),
		...(meta.hierarchy ? { hierarchy: meta.hierarchy } : {}),
	};
}

async function fetchFacet(
	router: CodeIntelligenceRouterAdvancedApi,
	resolved: ResolvedTarget,
	facet: InspectFacetName,
): Promise<FacetFetch> {
	const target = resolved.asked;
	const routing = resolved.routing;
	const limited: CodeIntelligenceRoutingOptions = { ...routing, limit: MAX_INSPECT_FACET_ITEMS };
	switch (facet) {
		case "definition": {
			const result = await resolved.definition();
			return { items: [...result.items], meta: result.meta };
		}
		case "hover": {
			const result = await router.hover(target, routing);
			return { items: [...result.items], meta: result.meta };
		}
		case "references": {
			const result = await router.findReferences(target, { ...limited, includeDeclaration: false });
			return { items: [...result.items], meta: result.meta };
		}
		case "implementations": {
			const result = await router.findImplementations(target, limited);
			return { items: [...result.items], meta: result.meta };
		}
		case "incoming_calls": {
			const result = await router.incomingCalls(target, limited);
			return { items: [...result.items], meta: result.meta };
		}
		case "outgoing_calls": {
			const result = await router.outgoingCalls(target, limited);
			return { items: [...result.items], meta: result.meta };
		}
		case "supertypes": {
			const result = await router.supertypes(target, limited);
			return { items: [...result.items], meta: result.meta };
		}
		case "subtypes": {
			const result = await router.subtypes(target, limited);
			return { items: [...result.items], meta: result.meta };
		}
		case "diagnostics": {
			if (!resolved.filePath) {
				throw new CodeIntelligenceRouterError("unsupported_target", "diagnostics need the target's file path", {
					operation: "diagnostics",
				});
			}
			const result = await router.getDiagnostics(resolved.filePath, routing);
			return { items: [...result.items], meta: result.meta };
		}
	}
}

function byFileOf(items: readonly InspectFacetItem[]): NonNullable<InspectFacet["byFile"]> {
	const counts = new Map<string, number>();
	for (const item of items) {
		const path = (item as CodeReference).location.path;
		counts.set(path, (counts.get(path) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([path, count]) => ({ path, count }))
		.sort((a, b) => compareStrings(a.path, b.path));
}

function targetIdentity(info: InspectTargetInfo, fallback: SymbolTarget): string {
	if (info.symbol) return symbolKey(info.symbol);
	return JSON.stringify(info.position ?? fallback);
}

async function resolveTarget(
	router: CodeIntelligenceRouterAdvancedApi,
	request: InspectRequest,
): Promise<ResolvedTarget> {
	const { target, routing } = request;
	if (target.type === "position") {
		const definition = lazy(() => router.findDefinition(target, routing));
		let symbol: CodeSymbol | undefined;
		try {
			symbol = (await definition()).items[0];
		} catch (cause) {
			if (isAbortError(cause) || routing.signal?.aborted) throw cause;
			// The target is still inspectable at its position; the definition facet reports the failure.
		}
		return {
			info: { symbol, position: { path: target.path, position: target.position } },
			asked: target,
			filePath: target.path,
			routing,
			definition,
		};
	}
	try {
		const resolved = await router.resolveSymbol(target.symbolId, routing);
		const symbol = resolved.items[0];
		const start = symbol.selectionRange?.start;
		const asked: SymbolTarget = start ? { type: "position", path: symbol.path, position: start } : target;
		const pinned: CodeIntelligenceRoutingOptions =
			routing.definitionId === undefined && symbol.provenance?.definitionId
				? { ...routing, definitionId: symbol.provenance.definitionId }
				: routing;
		return {
			info: { symbol, position: start ? { path: symbol.path, position: start } : undefined },
			asked,
			filePath: symbol.path,
			routing: pinned,
			definition: lazy(() => router.findDefinition(asked, pinned)),
		};
	} catch (cause) {
		if (isAbortError(cause) || routing.signal?.aborted) throw cause;
		const failure = classifyFacetFailure(cause);
		if (failure.status !== "stale") throw cause;
		return {
			info: {},
			asked: target,
			filePath: undefined,
			routing,
			definition: () => Promise.reject(cause),
			stale: failure.reason,
		};
	}
}

function snapshotOf(resolved: ResolvedTarget, facet: InspectFacetName, items: readonly InspectFacetItem[]): string {
	return fingerprint(
		`${targetIdentity(resolved.info, resolved.asked)}|${facet}|${items.map((item) => itemKey(facet, item)).join("\n")}`,
	);
}

function buildFacet(
	resolved: ResolvedTarget,
	request: InspectRequest,
	facet: InspectFacetName,
	fetched: FacetFetch,
	offset: number,
	expectedSnapshot: string | undefined,
): InspectFacet {
	const items = [...fetched.items].sort((left, right) => compareItems(facet, left, right));
	const meta = metaOf(fetched.meta);
	const snapshot = snapshotOf(resolved, facet, items);
	if (expectedSnapshot !== undefined && snapshot !== expectedSnapshot) {
		return {
			name: facet,
			status: "stale",
			items: [],
			total: items.length,
			offset,
			reason: "the answer changed since the first page was produced; ask again without the continuation",
			meta,
		};
	}
	const size = pageSizeOf(request);
	const page = items.slice(offset, offset + size);
	const hasMore = offset + size < items.length;
	const truncatedByBudget = items.length >= MAX_INSPECT_FACET_ITEMS;
	const warnings = [...(meta.warnings ?? [])];
	if (truncatedByBudget) warnings.push(`only the first ${MAX_INSPECT_FACET_ITEMS} items are available for paging`);
	return {
		name: facet,
		status: items.length === 0 ? "empty" : "ok",
		items: page,
		total: items.length,
		offset,
		...(hasMore ? { continuation: encodeContinuation({ request, facet, offset: offset + size, snapshot }) } : {}),
		...(facet === "references" ? { byFile: byFileOf(items) } : {}),
		meta: {
			...meta,
			completeness: truncatedByBudget ? "partial" : meta.completeness,
			...(warnings.length > 0 ? { warnings } : {}),
		},
	};
}

async function runFacet(
	router: CodeIntelligenceRouterAdvancedApi,
	resolved: ResolvedTarget,
	request: InspectRequest,
	facet: InspectFacetName,
	offset: number,
	expectedSnapshot: string | undefined,
): Promise<InspectFacet> {
	if (resolved.asked.type !== "position" && facet !== "diagnostics") {
		return {
			name: facet,
			status: "unsupported",
			items: [],
			total: 0,
			offset,
			reason:
				"the symbol has only line-level precision, so the language server cannot be asked about it; use a position target",
		};
	}
	try {
		const fetched = await fetchFacet(router, resolved, facet);
		return buildFacet(resolved, request, facet, fetched, offset, expectedSnapshot);
	} catch (cause) {
		if (isAbortError(cause) || request.routing.signal?.aborted) throw cause;
		const failure = classifyFacetFailure(cause);
		return { name: facet, status: failure.status, items: [], total: 0, offset, reason: failure.reason };
	}
}

function orderedFacets(requested: readonly InspectFacetName[] | undefined): InspectFacetName[] {
	if (!requested || requested.length === 0) return [...INSPECT_FACETS];
	const wanted = new Set(requested);
	return INSPECT_FACETS.filter((facet) => wanted.has(facet));
}

/** Ask every requested facet about the same object. Cancellation propagates; everything else becomes a status. */
export async function inspectSymbol(
	router: CodeIntelligenceRouterAdvancedApi,
	request: InspectRequest,
): Promise<InspectResult> {
	const started = Date.now();
	const resolved = await resolveTarget(router, request);
	const snapshot = fingerprint(targetIdentity(resolved.info, request.target));
	if (resolved.stale) return { target: resolved.info, snapshot, facets: [], stale: resolved.stale };
	const facets: InspectFacet[] = [];
	for (const facet of orderedFacets(request.facets)) {
		request.routing.signal?.throwIfAborted();
		if (Date.now() - started > INSPECT_TOTAL_BUDGET_MS) {
			facets.push({
				name: facet,
				status: "skipped",
				items: [],
				total: 0,
				offset: 0,
				reason: `the inspection time budget of ${INSPECT_TOTAL_BUDGET_MS / 1000}s was used up before this facet started`,
			});
			continue;
		}
		facets.push(await runFacet(router, resolved, request, facet, 0, undefined));
	}
	return { target: resolved.info, snapshot, facets };
}

/** Resume one facet from a continuation token. The token is bound to the answer it was issued for. */
export async function continueInspect(
	router: CodeIntelligenceRouterAdvancedApi,
	continuation: InspectContinuation,
): Promise<InspectResult> {
	const resolved = await resolveTarget(router, continuation.request);
	const snapshot = fingerprint(targetIdentity(resolved.info, continuation.request.target));
	if (resolved.stale) return { target: resolved.info, snapshot, facets: [], stale: resolved.stale };
	const facet = await runFacet(
		router,
		resolved,
		continuation.request,
		continuation.facet,
		continuation.offset,
		continuation.snapshot,
	);
	return { target: resolved.info, snapshot, facets: [facet] };
}
