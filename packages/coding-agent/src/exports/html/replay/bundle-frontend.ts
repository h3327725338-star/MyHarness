/**
 * Frontend bundler for the single-file HTML export (server-side, at export time — there is no build step).
 *
 * Starts from the module entry that `web/index.html` actually loads, walks the dependency graph over static
 * `import`, `export … from`, and `import("literal")` specifiers (found by `scanImports`), rewrites every
 * specifier to its bare name, and returns an import map of `bare name → data:text/javascript;base64,…`
 * (the approach validated by the W20 spike: bare specifiers resolve through the import map even on file://,
 * and each bare name maps to exactly one data: URL, so cycles need no topological ordering).
 *
 * Rewriting is verifiable and failures are loud (manager decision D-15):
 * - Rewritten modules are re-scanned: no path-like or scheme specifier may survive; a dangling bare name (not
 *   in the import map) is an error.
 * - Specifiers that cannot be resolved under `web/` (query/fragment, unknown absolute path, network URL,
 *   non-literal import) throw — nothing is silently skipped.
 * - Per-module `node --check --input-type=module` runs in the bundler's test sweep (`test/export-replay-bundler.test.ts`),
 *   not here, to keep export latency bounded on the user's machine.
 *
 * `webDir` defaults to the same location the Web server itself mounts `/assets/` from (`getWebUiDir()`),
 * so packaged and served files are always the same tree.
 */

import { readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { getWebUiDir } from "../../../config.ts";
import { type ImportKind, scanImports } from "./scan-imports.ts";

export interface BundledModuleDependency {
	/** Original specifier text in the module source. */
	readonly specifier: string;
	/** Rewritten bare specifier. */
	readonly bare: string;
	/** web/-relative path the specifier resolved to. */
	readonly rel: string;
	readonly kind: ImportKind;
}

export interface BundledModule {
	/** web/-relative path, e.g. "js/main.js". */
	readonly rel: string;
	/** Bare name used in the import map, e.g. "main.js". */
	readonly bare: string;
	/** Source with all specifiers rewritten to bare names. */
	readonly source: string;
	readonly dependencies: readonly BundledModuleDependency[];
	/** Byte length of the rewritten source (UTF-8). */
	readonly bytes: number;
}

export interface InlineCssFile {
	/** web/-relative path, e.g. "css/tokens.css". */
	readonly path: string;
	readonly content: string;
}

export interface BundleStats {
	readonly moduleCount: number;
	/** Total number of specifier rewrites across all modules. */
	readonly rewrittenSpecifierCount: number;
	/** Dynamic `import()` rewrites, reported for parity with the W20 prototype. */
	readonly dynamicRewrites: readonly string[];
	readonly importMapEntries: number;
	/** Cycle strings like "a.js -> b.js -> a.js" (informational: cycles are valid, the browser resolves them). */
	readonly cycles: readonly string[];
	/** Bytes of rewritten module sources. */
	readonly moduleBytes: number;
	/** Bytes of the serialized `{ imports: … }` import map. */
	readonly importMapBytes: number;
	/** Bytes of inlined CSS files. */
	readonly cssBytes: number;
	readonly cssFiles: readonly string[];
}

export interface BundleFrontendOptions {
	/** Web asset root; defaults to the directory the Web server mounts as `/assets/`. */
	readonly webDir?: string;
}

export interface BundleFrontendResult {
	/** bare name → `data:text/javascript;base64,…` */
	readonly importMap: Readonly<Record<string, string>>;
	/** Module entry loaded by index.html, as web-relative path and bare name. */
	readonly entry: { readonly rel: string; readonly bare: string };
	/** Stylesheets referenced by index.html, in load order. */
	readonly css: readonly InlineCssFile[];
	/** All bundled modules, keyed by web-relative path. */
	readonly modules: ReadonlyMap<string, BundledModule>;
	readonly stats: BundleStats;
}

export class BundleFrontendError extends Error {}

/**
 * `js/store.js` → `store.js`; `js/locales/zh-CN.js` → `locales/zh-CN.js`; `vendor/preact.js` → `preact.js`.
 * The rule is reversible via {@link bareToRel} and collisions must be checked by the caller.
 */
export function bareNameOf(rel: string): string {
	const n = rel.replace(/\\/g, "/");
	if (n.startsWith("js/locales/")) return `locales/${n.slice("js/locales/".length)}`;
	if (n.startsWith("js/")) return n.slice(3);
	if (n.startsWith("vendor/")) return n.slice(7);
	return n;
}

/** Reverse of {@link bareNameOf}; `undefined` when the bare name has no known directory prefix. */
export function bareToRel(bare: string): string | undefined {
	const n = bare.replace(/\\/g, "/");
	if (n.startsWith("locales/")) return `js/${n}`;
	if (n.startsWith("js/") || n.startsWith("vendor/")) return n;
	// Ambiguous bare forms ("store.js", "preact.js") resolve via the bundler's file-existence checks instead.
	return undefined;
}

function normalizeRel(p: string): string {
	const parts: string[] = [];
	for (const seg of p.replace(/\\/g, "/").split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (parts.length === 0) throw new BundleFrontendError(`路径跳出 web 目录根: ${p}`);
			parts.pop();
		} else parts.push(seg);
	}
	return parts.join("/");
}

function isFile(absolute: string): boolean {
	try {
		return statSync(absolute).isFile();
	} catch {
		return false;
	}
}

/**
 * Resolve one import specifier to a web/-relative path.
 * Accepted: `./x.js`, `../x.js`, `/assets/js/x.js`, `/vendor/x.js` (server mount forms) and bare names that
 * already exist under `js/` or `vendor/` (keeps rewritten sources re-bundlable). Anything else throws.
 */
export function resolveSpecifier(specifier: string, fromRel: string, webDir: string): string {
	if (/[?#]/.test(specifier)) throw new BundleFrontendError(`${fromRel}: 说明符带查询/片段，未支持: ${specifier}`);
	if (specifier.startsWith("/assets/")) {
		const rel = normalizeRel(specifier.slice("/assets/".length));
		if (!isFile(join(webDir, rel)))
			throw new BundleFrontendError(`${fromRel}: /assets/ 路径没有对应文件: ${specifier}`);
		return rel;
	}
	if (specifier.startsWith("/")) {
		if (specifier.startsWith("/vendor/")) {
			const rel = normalizeRel(`vendor/${specifier.slice("/vendor/".length)}`);
			if (!isFile(join(webDir, rel)))
				throw new BundleFrontendError(`${fromRel}: /vendor/ 路径没有对应文件: ${specifier}`);
			return rel;
		}
		throw new BundleFrontendError(`${fromRel}: 无法在 file:// 下解析的绝对说明符: ${specifier}`);
	}
	if (specifier.startsWith("./") || specifier.startsWith("../")) {
		const baseDir = dirname(fromRel);
		const rel = normalizeRel(join(baseDir === "." ? "" : baseDir, specifier));
		if (!isFile(join(webDir, rel)))
			throw new BundleFrontendError(`${fromRel}: 模块文件不存在: ${rel}（说明符 ${specifier}）`);
		return rel;
	}
	// Bare form: only valid if it already resolves to an existing js/ or vendor/ module (re-bundling safety).
	const asJs = `js/${specifier}`;
	const asVendor = `vendor/${specifier}`;
	if (isFile(join(webDir, asJs))) return asJs;
	if (isFile(join(webDir, asVendor))) return asVendor;
	throw new BundleFrontendError(`${fromRel}: 未支持的说明符形态（相对/绝对路径之外的写法）: ${specifier}`);
}

/** Rewrite every specifier in one module source to its bare name; throws when any specifier is unresolvable. */
export function rewriteModule(
	source: string,
	selfRel: string,
	webDir: string,
): { source: string; dependencies: BundledModuleDependency[] } {
	const found = scanImports(source);
	const dependencies: BundledModuleDependency[] = [];
	for (const hit of found) {
		if (source.slice(hit.start, hit.end) !== hit.specifier) {
			throw new BundleFrontendError(`${selfRel}: 扫描器区间与说明符不一致（index ${hit.start}）`);
		}
		const rel = resolveSpecifier(hit.specifier, selfRel, webDir);
		dependencies.push({ specifier: hit.specifier, bare: bareNameOf(rel), rel, kind: hit.kind });
	}
	// Apply edits from the end backwards so offsets stay valid.
	let out = source;
	for (const hit of [...found].sort((a, b) => b.start - a.start)) {
		const dependency = dependencies.find((d) => d.specifier === hit.specifier && d.kind === hit.kind);
		if (!dependency) throw new BundleFrontendError(`${selfRel}: 内部错误（说明符 ${hit.specifier} 缺少解析结果）`);
		out = `${out.slice(0, hit.start)}${dependency.bare}${out.slice(hit.end)}`;
	}
	return { source: out, dependencies };
}

/** Path-like specifiers (relative/absolute/scheme) must not survive rewriting. */
export function findPathLikeSpecifiers(source: string): string[] {
	const out: string[] = [];
	for (const hit of scanImports(source)) {
		if (
			/^\.{1,2}\//.test(hit.specifier) ||
			hit.specifier.startsWith("/") ||
			/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(hit.specifier)
		) {
			out.push(hit.specifier);
		}
	}
	return out;
}

/** DFS cycle report over the bare-name graph; cycles are legal (ESM supports them), this only reports them. */
export function findCycles(modules: ReadonlyMap<string, BundledModule>): string[] {
	const out: string[] = [];
	const state = new Map<string, number>();
	const stack: string[] = [];
	const byBare = new Map<string, BundledModule>();
	for (const m of modules.values()) byBare.set(m.bare, m);
	const visit = (bare: string): void => {
		const m = byBare.get(bare);
		if (!m) return;
		const s = state.get(bare);
		if (s === 2) return;
		if (s === 1) {
			const i = stack.indexOf(bare);
			if (i >= 0) out.push([...stack.slice(i), bare].join(" -> "));
			return;
		}
		state.set(bare, 1);
		stack.push(bare);
		for (const d of m.dependencies) visit(d.bare);
		stack.pop();
		state.set(bare, 2);
	};
	for (const bare of byBare.keys()) visit(bare);
	return [...new Set(out)];
}

function dataUrl(source: string): string {
	return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

interface HtmlAssetRefs {
	entryRel: string;
	cssRels: string[];
}

/** Read the module entry and stylesheet order that index.html actually loads (same as the served page). */
function readIndexHtmlAssetRefs(webDir: string): HtmlAssetRefs {
	const indexPath = join(webDir, "index.html");
	if (!isFile(indexPath)) throw new BundleFrontendError(`index.html 不存在: ${indexPath}`);
	const html = readFileSync(indexPath, "utf8");
	const moduleScripts = [...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*>/gi)];
	if (moduleScripts.length !== 1) {
		throw new BundleFrontendError(
			`index.html 必须有且只有一个 type="module" 脚本（实际 ${moduleScripts.length} 个）`,
		);
	}
	const srcMatch = /(?<=\s)src=["']([^"']+)["']/i.exec(moduleScripts[0]![0]);
	if (!srcMatch) throw new BundleFrontendError("index.html 的 module 脚本缺少 src");
	const entryRel = htmlPathToRel(srcMatch[1]!, "module 脚本");
	const cssRels: string[] = [];
	for (const link of html.matchAll(/<link\b[^>]*>/gi)) {
		if (!/\brel=["']stylesheet["']/i.test(link[0])) continue;
		const href = /(?<=\s)href=["']([^"']+)["']/i.exec(link[0]);
		if (!href) throw new BundleFrontendError("index.html 的 stylesheet link 缺少 href");
		cssRels.push(htmlPathToRel(href[1]!, "stylesheet"));
	}
	if (cssRels.length === 0) throw new BundleFrontendError("index.html 没有任何 stylesheet link");
	return { entryRel, cssRels };
}

function htmlPathToRel(url: string, what: string): string {
	if (url.startsWith("/assets/")) return normalizeRel(url.slice("/assets/".length));
	if (url.startsWith("/vendor/")) return normalizeRel(`vendor/${url.slice("/vendor/".length)}`);
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith("//")) {
		throw new BundleFrontendError(`${what} 指向外部 URL，无法内联: ${url}`);
	}
	throw new BundleFrontendError(`${what} 路径不在 /assets/ 或 /vendor/ 挂载点下: ${url}`);
}

export function bundleFrontend(options: BundleFrontendOptions = {}): BundleFrontendResult {
	const webDir = resolve(options.webDir ?? getWebUiDir());
	if (!isFile(join(webDir, "index.html"))) {
		throw new BundleFrontendError(`web 目录无效（缺少 index.html）: ${webDir}`);
	}
	const refs = readIndexHtmlAssetRefs(webDir);

	const modules = new Map<string, BundledModule>();
	const byBare = new Map<string, string>(); // bare → rel
	const queue: string[] = [refs.entryRel];
	while (queue.length > 0) {
		const rel = queue.shift()!;
		if (modules.has(rel)) continue;
		const absolute = join(webDir, rel);
		if (!isFile(absolute)) throw new BundleFrontendError(`模块文件不存在: ${rel}`);
		const { source, dependencies } = rewriteModule(readFileSync(absolute, "utf8"), rel, webDir);
		const bare = bareNameOf(rel);
		const clash = byBare.get(bare);
		if (clash !== undefined && clash !== rel) {
			throw new BundleFrontendError(`裸名冲突（两个文件重写后同名）: ${clash} vs ${rel} → ${bare}`);
		}
		byBare.set(bare, rel);
		modules.set(rel, { rel, bare, source, dependencies, bytes: Buffer.byteLength(source, "utf8") });
		for (const d of dependencies) queue.push(d.rel);
	}

	// Verifiable rewrite: re-scan every rewritten module — no path-like specifiers, no dangling bare names.
	for (const m of modules.values()) {
		const leftovers = findPathLikeSpecifiers(m.source);
		if (leftovers.length > 0) {
			throw new BundleFrontendError(`重写后仍残留路径形态说明符（${m.rel}）: ${leftovers.join(", ")}`);
		}
		for (const d of m.dependencies) {
			if (!byBare.has(d.bare))
				throw new BundleFrontendError(`悬空依赖（${m.rel}）: 裸名 ${d.bare} 不在 importmap 里`);
		}
	}

	const importMap: Record<string, string> = {};
	for (const [bare, rel] of [...byBare].sort((a, b) => a[0].localeCompare(b[0]))) {
		const m = modules.get(rel)!;
		importMap[bare] = dataUrl(m.source);
	}

	const css: InlineCssFile[] = refs.cssRels.map((rel) => {
		const absolute = join(webDir, rel);
		if (!isFile(absolute)) throw new BundleFrontendError(`CSS 文件不存在: ${rel}`);
		return { path: rel, content: readFileSync(absolute, "utf8") };
	});

	const dynamicRewrites: string[] = [];
	let rewrittenSpecifierCount = 0;
	let moduleBytes = 0;
	for (const m of modules.values()) {
		moduleBytes += m.bytes;
		rewrittenSpecifierCount += m.dependencies.length;
		for (const d of m.dependencies) if (d.kind === "dynamic") dynamicRewrites.push(`${m.rel} -> ${d.specifier}`);
	}
	const importMapBytes = Buffer.byteLength(JSON.stringify({ imports: importMap }), "utf8");
	const cssBytes = css.reduce((a, f) => a + Buffer.byteLength(f.content, "utf8"), 0);

	return {
		importMap,
		entry: { rel: refs.entryRel, bare: bareNameOf(refs.entryRel) },
		css,
		modules,
		stats: {
			moduleCount: modules.size,
			rewrittenSpecifierCount,
			dynamicRewrites,
			importMapEntries: Object.keys(importMap).length,
			cycles: findCycles(modules),
			moduleBytes,
			importMapBytes,
			cssBytes,
			cssFiles: css.map((f) => f.path),
		},
	};
}
