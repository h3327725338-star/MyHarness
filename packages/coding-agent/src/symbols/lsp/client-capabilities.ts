import type { LspClientCapabilities } from "./types.ts";

/**
 * Client capabilities announced in `initialize` when a definition does not
 * bring its own. Only features the semantic backend really consumes are
 * declared: hierarchical document symbols (name range and body range),
 * definition links, references, implementations, hover, call and type
 * hierarchy, rename with prepareRename, push and pull diagnostics, workspace
 * symbols, and text-only workspace edits (no file create/rename/delete).
 *
 * Without these declarations servers fall back to the oldest protocol shapes:
 * typescript-language-server, for example, then returns flat
 * SymbolInformation whose range covers the whole declaration, so the "name"
 * position of every symbol is really the start of its body.
 */
export const DEFAULT_LSP_CLIENT_CAPABILITIES: LspClientCapabilities = Object.freeze({
	general: { positionEncodings: ["utf-16"] },
	textDocument: {
		synchronization: { dynamicRegistration: false, didSave: false, willSave: false, willSaveWaitUntil: false },
		documentSymbol: {
			dynamicRegistration: false,
			hierarchicalDocumentSymbolSupport: true,
			symbolKind: { valueSet: Array.from({ length: 26 }, (_, index) => index + 1) },
		},
		definition: { dynamicRegistration: false, linkSupport: true },
		implementation: { dynamicRegistration: false, linkSupport: true },
		references: { dynamicRegistration: false },
		hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
		callHierarchy: { dynamicRegistration: false },
		typeHierarchy: { dynamicRegistration: false },
		rename: { dynamicRegistration: false, prepareSupport: true },
		publishDiagnostics: { relatedInformation: false, versionSupport: true },
		diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
	},
	workspace: {
		applyEdit: false,
		workspaceFolders: true,
		configuration: true,
		symbol: {
			dynamicRegistration: false,
			symbolKind: { valueSet: Array.from({ length: 26 }, (_, index) => index + 1) },
		},
		workspaceEdit: { documentChanges: true, resourceOperations: [], failureHandling: "abort" },
	},
	window: { workDoneProgress: true },
	// rust-analyzer reports whether it has finished loading and indexing the workspace.
	experimental: { serverStatusNotification: true },
}) as LspClientCapabilities;
