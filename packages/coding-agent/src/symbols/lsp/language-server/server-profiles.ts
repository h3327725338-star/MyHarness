/**
 * Known behavioral differences between language servers that the generic LSP layer cannot learn from
 * the protocol. They are observations of specific servers (verified against the real binaries and
 * recorded in the feature matrix), not guesses about every server of a language.
 */

import type { JsonObject } from "../types.ts";
import type { LanguageServerDefinition } from "./types.ts";

export interface LanguageServerProfile {
	/**
	 * workspace: `workspace/symbol` searches the whole workspace.
	 * opened-project: it only searches the project of the document opened last (tsserver behavior), so a
	 * query has to open one anchor document per project to cover several projects.
	 */
	readonly workspaceSymbolScope: "workspace" | "opened-project";
	/**
	 * The server does not provide standard `typeHierarchy`; the named adapter derives explicit
	 * extends/implements relations from the project's compiler instead.
	 */
	readonly typeHierarchyAdapter?: "typescript";
	/** Server startup policy, not a claim about client capabilities. */
	readonly initializationOptions?: JsonObject;
}

const DEFAULT_PROFILE: LanguageServerProfile = Object.freeze({ workspaceSymbolScope: "workspace" });

const TYPESCRIPT_PROFILE: LanguageServerProfile = Object.freeze({
	workspaceSymbolScope: "opened-project",
	typeHierarchyAdapter: "typescript",
	// Auto mode routes references/rename to the syntax server while the configured project is loading.
	// That server sees only open files and can return a successful but incomplete edit. Use the semantic
	// server from the first request instead; no sleep or guessed project-loading delay is needed.
	initializationOptions: { tsserver: { useSyntaxServer: "never" } },
});

function isTypeScriptLanguageServer(definition: LanguageServerDefinition): boolean {
	if (/typescript/iu.test(definition.id)) return true;
	if (/typescript-language-server/iu.test(definition.command)) return true;
	return definition.args.some((argument) => /typescript-language-server/iu.test(argument));
}

export function resolveServerProfile(definition: LanguageServerDefinition): LanguageServerProfile {
	return isTypeScriptLanguageServer(definition) ? TYPESCRIPT_PROFILE : DEFAULT_PROFILE;
}
