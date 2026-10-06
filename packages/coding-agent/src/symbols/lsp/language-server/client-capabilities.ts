/**
 * Client capabilities that MyHarness actually implements.
 *
 * `LspClient` is a protocol client and defaults to `{}`. The product manager
 * owns the decision of what the semantic backend can really handle, so this
 * module provides that profile and the rules for merging a server definition's
 * override into it.
 *
 * Rules:
 * - Only advertise behavior that exists in the semantic backend. A capability is
 *   added to {@link PRODUCT_CLIENT_FEATURES} in the same change that implements
 *   and tests it; it is never set "to make a server return more".
 * - A definition override may narrow or disable fields (a `null` leaf removes the
 *   key, `false` disables a flag, an array may only keep a subset). It can never
 *   enable something the profile does not advertise; such leaves are dropped and
 *   reported so a stale override cannot silently over-promise.
 * - Merging is nested. A shallow spread would drop the whole `textDocument`
 *   branch as soon as an override touched one sibling.
 */

import type { JsonObject, JsonValue, LspClientCapabilities } from "../types.ts";

/** Behavior the backend implements beyond the always-on query surface. */
export interface ProductClientFeatures {
	/** `textDocument/prepareRename` + `textDocument/rename` produce a WorkspaceEdit plan. */
	readonly rename: boolean;
	/** `workspace/applyEdit` requests are answered by an authorized changeset executor. */
	readonly applyEdit: boolean;
	/** `textDocument/diagnostic` pull reports (resultId, unchanged, relatedDocuments). */
	readonly pullDiagnostics: boolean;
	/** `workspace/diagnostic/refresh` invalidates the diagnostics barrier. */
	readonly diagnosticRefresh: boolean;
}

/** What the current build implements. Flip a flag together with its implementation and test. */
export const PRODUCT_CLIENT_FEATURES: ProductClientFeatures = Object.freeze({
	rename: true,
	applyEdit: false,
	pullDiagnostics: false,
	diagnosticRefresh: false,
});

/** LSP 3.17 SymbolKind values the converters understand (everything else maps to "unknown"). */
const SYMBOL_KIND_VALUE_SET: readonly number[] = Object.freeze(Array.from({ length: 26 }, (_, index) => index + 1));

export function createProductClientCapabilities(
	features: ProductClientFeatures = PRODUCT_CLIENT_FEATURES,
): LspClientCapabilities {
	const textDocument: JsonObject = {
		synchronization: {
			dynamicRegistration: false,
			willSave: false,
			willSaveWaitUntil: false,
			didSave: false,
		},
		documentSymbol: {
			dynamicRegistration: false,
			hierarchicalDocumentSymbolSupport: true,
			symbolKind: { valueSet: [...SYMBOL_KIND_VALUE_SET] },
		},
		definition: { dynamicRegistration: false, linkSupport: true },
		implementation: { dynamicRegistration: false, linkSupport: true },
		references: { dynamicRegistration: false },
		codeAction: {
			dynamicRegistration: false,
			codeActionLiteralSupport: {
				codeActionKind: { valueSet: ["refactor", "refactor.extract", "refactor.inline", "refactor.rewrite"] },
			},
			resolveSupport: { properties: ["edit"] },
		},
		hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
		callHierarchy: { dynamicRegistration: false },
		typeHierarchy: { dynamicRegistration: false },
		publishDiagnostics: { relatedInformation: false, versionSupport: true },
	};
	if (features.pullDiagnostics) {
		textDocument.diagnostic = { dynamicRegistration: false, relatedDocumentSupport: true };
	}
	if (features.rename) {
		// defaultBehavior (1 = identifier): the backend reads the identifier under the cursor itself.
		textDocument.rename = { dynamicRegistration: false, prepareSupport: true, prepareSupportDefaultBehavior: 1 };
	}

	const workspace: JsonObject = {
		symbol: { dynamicRegistration: false, symbolKind: { valueSet: [...SYMBOL_KIND_VALUE_SET] } },
	};
	if (features.rename || features.applyEdit) {
		// Text edits only: the WorkspaceEdit codec refuses resource operations (create/rename/delete), so an empty
		// resourceOperations list is advertised. Inserted text is normalized to the line ending of the document.
		workspace.workspaceEdit = {
			documentChanges: true,
			resourceOperations: [],
			normalizesLineEndings: true,
			changeAnnotationSupport: { groupsOnLabel: false },
			// Promise only what holds even when a file changed under the edit: a failed change stops the rest.
			...(features.applyEdit ? { failureHandling: "abort" } : {}),
		};
	}
	if (features.applyEdit) workspace.applyEdit = true;
	if (features.diagnosticRefresh) {
		workspace.diagnostics = { refreshSupport: true };
	}

	return deepFreeze({
		general: { positionEncodings: ["utf-16"] },
		textDocument,
		workspace,
	});
}

export interface CapabilityMergeResult {
	readonly capabilities: LspClientCapabilities;
	/** Override leaves that were ignored because they would enable an unimplemented capability. */
	readonly rejected: readonly string[];
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T extends JsonValue | undefined>(value: T): T {
	return structuredClone(value);
}

function acceptLeaf(base: JsonValue | undefined, override: JsonValue): boolean {
	if (base === undefined) return false;
	if (typeof override === "boolean") return override === base || override === false;
	if (Array.isArray(override)) {
		return (
			Array.isArray(base) &&
			override.every((item) => base.some((candidate) => JSON.stringify(candidate) === JSON.stringify(item)))
		);
	}
	return JSON.stringify(override) === JSON.stringify(base);
}

function mergeInto(
	target: JsonObject,
	base: JsonObject | undefined,
	override: JsonObject,
	path: string,
	rejected: string[],
): void {
	for (const [key, overrideValue] of Object.entries(override)) {
		if (overrideValue === undefined) continue;
		const currentPath = path === "" ? key : `${path}.${key}`;
		const baseValue = base?.[key];
		if (overrideValue === null) {
			// Explicit disable: removing a key is always allowed, including a branch.
			delete target[key];
			continue;
		}
		if (isObject(overrideValue)) {
			if (!isObject(baseValue)) {
				rejected.push(currentPath);
				continue;
			}
			const targetChild = isObject(target[key]) ? (target[key] as JsonObject) : {};
			target[key] = targetChild;
			mergeInto(targetChild, baseValue, overrideValue, currentPath, rejected);
			continue;
		}
		if (acceptLeaf(baseValue, overrideValue)) {
			target[key] = cloneValue(overrideValue);
		} else {
			rejected.push(currentPath);
		}
	}
}

/**
 * Merge a definition override into the product profile. The result never contains a leaf the
 * profile did not advertise (the override can only narrow), and the profile object is not mutated.
 */
export function mergeClientCapabilities(
	base: LspClientCapabilities,
	override: LspClientCapabilities | undefined,
): CapabilityMergeResult {
	const merged = cloneValue(base) as JsonObject;
	const rejected: string[] = [];
	if (override !== undefined) mergeInto(merged, base, override, "", rejected);
	return { capabilities: deepFreeze(merged), rejected };
}

/** Effective initialize capabilities for one definition. */
export function resolveClientCapabilities(
	override: LspClientCapabilities | undefined,
	features: ProductClientFeatures = PRODUCT_CLIENT_FEATURES,
): CapabilityMergeResult {
	return mergeClientCapabilities(createProductClientCapabilities(features), override);
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return Object.freeze(value);
}
