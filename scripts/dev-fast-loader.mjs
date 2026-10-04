/**
 * Fast dev loader: lets plain `node` run the repository's TypeScript sources.
 *
 * tsx sends every one of the ~1600 modules MyHarness loads at startup (668 of them in
 * `typebox` alone) through its transform hooks, which costs about 10 seconds before the
 * Web UI can listen. The sources use erasable-only TypeScript (`erasableSyntaxOnly` in
 * tsconfig.base.json), so Node's built-in type stripping is enough; the only thing tsx did
 * beyond that is applying the `paths` aliases from the root tsconfig.json, which this file
 * reproduces for the `@myharness/*` workspace packages.
 *
 * Usage: node --import ./scripts/dev-fast-loader.mjs packages/coding-agent/src/web.ts ...
 * It is only used by the Windows dev launcher (web-runtime.ps1); tests and other tools keep using
 * tsx / vitest.
 */

import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadPathAliases() {
	const config = JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf8"));
	const paths = config.compilerOptions?.paths ?? {};
	const aliases = [];
	for (const [pattern, targets] of Object.entries(paths)) {
		// The bare "*" entry only matters for type checking; every other specifier resolves normally.
		if (!pattern.startsWith("@myharness/")) continue;
		const star = pattern.indexOf("*");
		aliases.push({
			prefix: star === -1 ? pattern : pattern.slice(0, star),
			exact: star === -1,
			targets,
		});
	}
	// Exact patterns win over wildcard ones, longer prefixes over shorter ones (TypeScript's rule).
	aliases.sort((a, b) => Number(b.exact) - Number(a.exact) || b.prefix.length - a.prefix.length);
	return aliases;
}

const aliases = loadPathAliases();

function resolveAlias(specifier) {
	for (const alias of aliases) {
		if (alias.exact ? specifier !== alias.prefix : !specifier.startsWith(alias.prefix)) continue;
		const rest = alias.exact ? "" : specifier.slice(alias.prefix.length);
		for (const target of alias.targets) {
			const file = resolve(root, target.replace("*", rest));
			if (existsSync(file)) return pathToFileURL(file).href;
		}
	}
	return undefined;
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("@myharness/")) {
			const url = resolveAlias(specifier);
			if (url) return nextResolve(url, context);
		}
		return nextResolve(specifier, context);
	},
});
