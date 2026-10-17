import type { JsonObject } from "../lsp/types.ts";

/**
 * initializationOptions for the private language servers, by launcher key.
 *
 * typescript-language-server normally answers through a separate "syntax
 * server" until the semantic tsserver has loaded the project. In that window
 * references and rename only see the open files, so a rename silently skips
 * every other file (measured: 1 of 3 files right after opening, 3 of 3 a few
 * seconds later). With `useSyntaxServer: "never"` every request waits for the
 * project-wide semantic server instead, which is what cross-file queries need.
 */
const INITIALIZATION_OPTIONS: Readonly<Record<string, JsonObject>> = Object.freeze({
	"typescript-language-server": { tsserver: { useSyntaxServer: "never" } },
});

export function initializationOptionsForServer(serverKey: string): JsonObject | undefined {
	const options = INITIALIZATION_OPTIONS[serverKey];
	return options === undefined ? undefined : structuredClone(options);
}
