import type { LspInitializeResult } from "../lsp/types.ts";
import { SemanticBackendError, SemanticUnsupportedPositionEncodingError } from "./errors.ts";
import { isFiniteInteger, isJsonObject, isProviderSupported } from "./lsp-types.ts";
import type { SemanticCapabilities, SemanticTextDocumentSyncKind } from "./types.ts";

function parseSyncKind(value: unknown): SemanticTextDocumentSyncKind {
	if (!isFiniteInteger(value)) {
		throw new SemanticBackendError("invalid_server_response", "textDocumentSync change kind must be an integer");
	}
	if (value === 0) return "none";
	if (value === 1) return "full";
	if (value === 2) return "incremental";
	throw new SemanticBackendError("invalid_server_response", `unknown textDocumentSync change kind: ${value}`);
}

function parseTextDocumentSync(value: unknown): Pick<SemanticCapabilities, "textDocumentSync" | "openClose"> {
	if (value === undefined) return { textDocumentSync: "none", openClose: false };
	if (isFiniteInteger(value)) {
		const textDocumentSync = parseSyncKind(value);
		return { textDocumentSync, openClose: false };
	}
	if (!isJsonObject(value)) {
		throw new SemanticBackendError("invalid_server_response", "textDocumentSync must be a number or object");
	}
	const openClose = value.openClose === undefined ? false : value.openClose;
	if (typeof openClose !== "boolean") {
		throw new SemanticBackendError("invalid_server_response", "textDocumentSync.openClose must be boolean");
	}
	const change = value.change === undefined ? 0 : value.change;
	return { textDocumentSync: parseSyncKind(change), openClose };
}

function parsePositionEncoding(value: unknown): "utf-16" {
	if (value === undefined) return "utf-16";
	if (typeof value !== "string" || value.toLowerCase() !== "utf-16") {
		throw new SemanticUnsupportedPositionEncodingError(value);
	}
	return "utf-16";
}

function parseProvider(value: unknown): { supported: boolean; resolveProvider: boolean } {
	if (value === true) return { supported: true, resolveProvider: false };
	if (!isJsonObject(value)) return { supported: false, resolveProvider: false };
	if (value.resolveProvider !== undefined && typeof value.resolveProvider !== "boolean") {
		throw new SemanticBackendError("invalid_server_response", "provider.resolveProvider must be boolean");
	}
	return { supported: true, resolveProvider: value.resolveProvider === true };
}

function parseRenameProvider(value: unknown): { supported: boolean; prepareProvider: boolean } {
	if (value === true) return { supported: true, prepareProvider: false };
	if (!isJsonObject(value)) return { supported: false, prepareProvider: false };
	if (value.prepareProvider !== undefined && typeof value.prepareProvider !== "boolean") {
		throw new SemanticBackendError("invalid_server_response", "renameProvider.prepareProvider must be boolean");
	}
	return { supported: true, prepareProvider: value.prepareProvider === true };
}

export function parseSemanticCapabilities(result: LspInitializeResult | undefined): SemanticCapabilities {
	const capabilities = result?.capabilities;
	if (!isJsonObject(capabilities)) {
		throw new SemanticBackendError("invalid_server_response", "initialize result capabilities must be an object");
	}
	const sync = parseTextDocumentSync(capabilities.textDocumentSync);
	const workspaceSymbol = parseProvider(capabilities.workspaceSymbolProvider);
	const hover = parseProvider(capabilities.hoverProvider);
	const callHierarchy = parseProvider(capabilities.callHierarchyProvider);
	const typeHierarchy = parseProvider(capabilities.typeHierarchyProvider);
	const diagnostic = parseProvider(capabilities.diagnosticProvider);
	const rename = parseRenameProvider(capabilities.renameProvider);
	return Object.freeze({
		...sync,
		diagnosticProvider: diagnostic.supported,
		documentSymbolProvider: isProviderSupported(capabilities.documentSymbolProvider),
		definitionProvider: isProviderSupported(capabilities.definitionProvider),
		referencesProvider: isProviderSupported(capabilities.referencesProvider),
		implementationProvider: isProviderSupported(capabilities.implementationProvider),
		workspaceSymbolProvider: workspaceSymbol.supported,
		workspaceSymbolResolveProvider: workspaceSymbol.resolveProvider,
		hoverProvider: hover.supported,
		callHierarchyProvider: callHierarchy.supported,
		typeHierarchyProvider: typeHierarchy.supported,
		renameProvider: rename.supported,
		prepareRenameProvider: rename.prepareProvider,
		positionEncoding: parsePositionEncoding(capabilities.positionEncoding),
	});
}
