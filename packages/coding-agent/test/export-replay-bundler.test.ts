/**
 * W22 — HTML 导出步骤 2：前端打包器（replay/bundle-frontend.ts + replay/scan-imports.ts）。
 *
 * 五类检查对应工单验收 (a)–(e)：
 * (a) 真实前端（web/js + web/vendor）打包后：重写后再扫一遍无路径形态 import、无悬空裸名、循环依赖按原型处理；
 * (b) 逐模块 `node --check --input-type=module`（spawnSync 从 stdin 喂源码）失败数 = 0；
 * (c) 扫描器与 es-module-lexer 在全部前端模块上交叉对照一致；
 * (d) 反例必须抛错：`import(x)`、`import.meta.url`、模板字符串说明符、未知后缀；
 * (e) 扫描器小型单元用例：字符串/模板字符串/注释/正则里的 `import "x"` 不应被误扫。
 *
 * es-module-lexer 只允许出现在测试里（D-15：它是 vitest 的传递依赖，生产安装不存在）。
 */

import { spawnSync } from "child_process";
import { init as initLexer, parse as parseLexer } from "es-module-lexer";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { describe, expect, it } from "vitest";
import { getWebUiDir } from "../src/config.ts";
import {
	type BundleFrontendResult,
	bareNameOf,
	bareToRel,
	bundleFrontend,
	findCycles,
	resolveSpecifier,
} from "../src/exports/html/replay/bundle-frontend.ts";
import { type ScannedImport, scanImports } from "../src/exports/html/replay/scan-imports.ts";

// Web 服务本身用 getWebUiDir() 挂载 /assets/，打包器复用它（bundleFrontend 默认值相同），这里显式传入同一个目录。
const webDir = resolve(getWebUiDir());

/** 真实前端的全部 .js 模块（web/js 含 locales 子目录 + web/vendor），boot-theme.js 是经典脚本、单独列出。 */
function listFrontendJsFiles(): string[] {
	const out: string[] = [];
	const walk = (rel: string): void => {
		for (const e of readdirSync(join(webDir, rel), { withFileTypes: true })) {
			const child = rel === "" ? e.name : `${rel}/${e.name}`;
			if (e.isDirectory()) walk(child);
			else if (e.isFile() && e.name.endsWith(".js")) out.push(child);
		}
	};
	walk("js");
	walk("vendor");
	return out.sort();
}

let realBundle: BundleFrontendResult | undefined;
function getRealBundle(): BundleFrontendResult {
	realBundle ??= bundleFrontend({ webDir });
	return realBundle;
}

/** 语法校验：把源码从 stdin 喂给 node --check --input-type=module。返回 null 表示通过。 */
function checkModuleSyntax(source: string): string | null {
	const probe = spawnSync(process.execPath, ["--check", "--input-type=module", "-"], {
		input: source,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
	});
	if (probe.status === 0) return null;
	return `${probe.status}: ${`${probe.stderr || probe.stdout || ""}`.trim().split("\n")[0]}`;
}

/** es-module-lexer 声明 → 与扫描器同款 {kind, specifier}（lexer 的 d>=0 是动态 import；ss..se 起头是 export 的是 export-from）。 */
function lexerFindings(source: string): string[] {
	const [declarations] = parseLexer(source, "cross-check.js");
	return (
		declarations
			.map((d) => {
				const kind =
					d.d !== undefined && d.d >= 0
						? "dynamic"
						: /^\s*export\b/.test(source.slice(d.ss ?? 0, d.se ?? 0))
							? "export-from"
							: "static";
				return `${kind}:${d.n}`;
			})
			// The scanner deliberately skips server-only pdf.js assets (see RUNTIME_ONLY_PREFIX).
			.filter((entry) => !entry.startsWith("dynamic:/vendor-pdf/"))
			.sort()
	);
}

function scannerFindings(found: readonly ScannedImport[]): string[] {
	return found.map((f) => `${f.kind}:${f.specifier}`).sort();
}

/** 最小合成 web 目录（一个 index.html + 给定模块文件），用来做反例和循环依赖用例。 */
function makeTempWebDir(files: Record<string, string>): string {
	const base = process.env.MYHARNESS_TEMP_DIR ?? tmpdir();
	const dir = mkdtempSync(join(base, "w22-bundler-"));
	const html = [
		"<!doctype html>",
		'<link rel="stylesheet" href="/assets/css/base.css" />',
		'<script type="module" src="/assets/js/main.js"></script>',
	].join("\n");
	writeFileSync(join(dir, "index.html"), html, "utf8");
	const all: Record<string, string> = { "css/base.css": ":root {}", ...files };
	for (const [rel, content] of Object.entries(all)) {
		const absolute = join(dir, rel);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content, "utf8");
	}
	return dir;
}

describe("W22 (a) 真实前端打包：重写可验证", () => {
	it("打包全部前端模块后，重写后的源码再扫一遍没有路径形态说明符", () => {
		const bundle = getRealBundle();
		const leftovers: string[] = [];
		for (const m of bundle.modules.values()) {
			for (const hit of scanImports(m.source)) {
				if (
					/^\.{1,2}\//.test(hit.specifier) ||
					hit.specifier.startsWith("/") ||
					/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(hit.specifier)
				) {
					leftovers.push(`${m.rel}: ${hit.specifier}`);
				}
			}
		}
		expect(leftovers).toEqual([]);
	});

	it("打包覆盖 web/js + web/vendor 的全部模块（除经典脚本 boot-theme.js），入口与 index.html 一致", () => {
		const bundle = getRealBundle();
		const diskFiles = listFrontendJsFiles();
		const expected = diskFiles.filter((rel) => rel !== "js/boot-theme.js");
		expect([...bundle.modules.keys()].sort()).toEqual(expected);
		expect(bundle.entry).toEqual({ rel: "js/main.js", bare: "main.js" });
		expect(bundle.stats.moduleCount).toBe(bundle.modules.size);
	});

	it("没有悬空裸名：每个重写后的说明符都能在 importmap 里找到", () => {
		const bundle = getRealBundle();
		const importMapKeys = new Set(Object.keys(bundle.importMap));
		const dangling: string[] = [];
		for (const m of bundle.modules.values()) {
			for (const d of m.dependencies) {
				if (!importMapKeys.has(d.bare)) dangling.push(`${m.rel} -> ${d.bare}`);
			}
		}
		expect(dangling).toEqual([]);
	});

	it("真实模块图仅含已知懒加载环；人造循环按原型处理（a→b→a 可打包、同一裸名映射同一 data: URL）", () => {
		const bundle = getRealBundle();
		// actions.js 懒加载 service-restart.js（/reload），后者静态回引 actions.js，属已知预期环。
		expect(bundle.stats.cycles).toEqual(["actions.js -> service-restart.js -> actions.js"]);
		expect(findCycles(bundle.modules)).toEqual(["actions.js -> service-restart.js -> actions.js"]);

		const dir = makeTempWebDir({
			"js/main.js": 'import { x } from "./a.js";\nexport const y = x;',
			"js/a.js": 'import { b } from "./b.js";\nexport const x = b;',
			"js/b.js": 'import { x } from "./a.js";\nexport const b = x;',
		});
		const cyclic = bundleFrontend({ webDir: dir });
		expect(cyclic.stats.cycles).toEqual(["a.js -> b.js -> a.js"]);
		expect(Object.keys(cyclic.importMap).sort()).toEqual(["a.js", "b.js", "main.js"]);
		// 循环不需要拓扑拼接：裸名 → 固定 data: URL，浏览器原生模块图自己处理环。
		expect(cyclic.importMap["a.js"]).toBe(
			`data:text/javascript;base64,${Buffer.from(cyclic.modules.get("js/a.js")!.source, "utf8").toString("base64")}`,
		);
	});

	it("裸名规则可逆且不冲突；动态 import 也被重写为裸名", () => {
		const bundle = getRealBundle();
		expect(bareNameOf("js/store.js")).toBe("store.js");
		expect(bareNameOf("js/locales/zh-CN.js")).toBe("locales/zh-CN.js");
		expect(bareNameOf("vendor/preact.js")).toBe("preact.js");
		expect(bareToRel("locales/zh-CN.js")).toBe("js/locales/zh-CN.js");
		const bareSeen = new Map<string, string>();
		for (const m of bundle.modules.values()) {
			const clash = bareSeen.get(m.bare);
			expect(clash === undefined || clash === m.rel, `裸名冲突: ${m.bare}`).toBe(true);
			bareSeen.set(m.bare, m.rel);
		}
		expect(bundle.stats.dynamicRewrites).toEqual([
			"js/actions.js -> ./service-restart.js",
			"js/terminal-session.js -> /vendor/xterm.js",
			"js/terminal-session.js -> /vendor/xterm-addon-fit.js",
		]);
		const terminal = bundle.modules.get("js/terminal-session.js")!;
		expect(scanImports(terminal.source).map((f) => f.specifier)).toContain("xterm.js");
	});

	it("CSS 按 index.html 的顺序内联", () => {
		const bundle = getRealBundle();
		expect(bundle.stats.cssFiles).toEqual([
			"vendor/xterm.css",
			"css/tokens.css",
			"css/base.css",
			"css/layout.css",
			"css/transcript.css",
			"css/composer.css",
			"css/panels.css",
			"css/overlays.css",
		]);
		for (const f of bundle.css) {
			expect(f.content.length).toBeGreaterThan(0);
			expect(f.content).toBe(readFileSync(join(webDir, f.path), "utf8"));
		}
	});
});

describe("W22 (b) 逐模块语法校验", () => {
	it("重写后的全部模块通过 node --check --input-type=module（失败数=0）", () => {
		const bundle = getRealBundle();
		const failures: string[] = [];
		let checked = 0;
		for (const m of bundle.modules.values()) {
			const error = checkModuleSyntax(m.source);
			if (error !== null) failures.push(`${m.rel}: ${error}`);
			checked++;
		}
		expect(checked).toBe(bundle.stats.moduleCount);
		expect(failures).toEqual([]);
	}, 180_000);

	it("语法校验器本身不是摆设：坏语法必须被拒绝", () => {
		expect(checkModuleSyntax('import { a } from "store.js";\nexport const b = a;')).toBeNull();
		expect(checkModuleSyntax("import { from")).not.toBeNull();
	});
});

describe("W22 (c) 扫描器与 es-module-lexer 交叉对照", () => {
	it("在全部前端模块（web/js + web/vendor）上结果一致", async () => {
		await initLexer;
		const files = listFrontendJsFiles();
		expect(files.length).toBeGreaterThanOrEqual(70);
		const compared: string[] = [];
		let totalDeclarations = 0;
		for (const rel of files) {
			const source = readFileSync(join(webDir, rel), "utf8");
			let mine: string[];
			try {
				mine = scannerFindings(scanImports(source));
			} catch (error) {
				throw new Error(`${rel}: 扫描器抛错: ${(error as Error).message}`);
			}
			const theirs = lexerFindings(source);
			totalDeclarations += theirs.length;
			compared.push(`${rel} [${mine.length}]`);
			expect(theirs, `${rel}: 扫描器与 es-module-lexer 不一致`).toEqual(mine);
		}
		expect(totalDeclarations).toBeGreaterThan(0);
		expect(compared.length).toBe(files.length);
	});
});

describe("W22 (d) 反例必须抛错", () => {
	it("非字面量动态 import(x) 抛错", () => {
		expect(() => scanImports('const p = "./x.js";\nconst m = await import(p);')).toThrow(/dynamic import/);
	});

	it("import.meta.url 抛错", () => {
		expect(() => scanImports("const u = import.meta.url;\nexport { u };")).toThrow(/import\.meta/);
	});

	it("模板字符串说明符抛错（动态与静态两处）", () => {
		const tick = "`";
		expect(() => scanImports(`const m = await import(${tick}./x.js${tick});`)).toThrow();
		expect(() => scanImports(`export { a } from ${tick}./x.js${tick};`)).toThrow();
	});

	it("静态 import 的非字符串说明符与空说明符抛错", () => {
		expect(() => scanImports("import x from y;\nexport { x };")).toThrow();
		expect(() => scanImports('import "";')).toThrow(/empty/i);
	});

	it("未知后缀 / 未知形态说明符在打包时抛错（不静默跳过）", () => {
		const dir = makeTempWebDir({
			"js/main.js": 'import { x } from "./mystery.unknownext";\nexport const y = x;',
		});
		expect(() => bundleFrontend({ webDir: dir })).toThrow(/mystery\.unknownext/);

		const dir2 = makeTempWebDir({
			"js/main.js": 'import { x } from "https://example.com/x.js";\nexport const y = x;',
		});
		expect(() => bundleFrontend({ webDir: dir2 })).toThrow();

		const dir3 = makeTempWebDir({
			"js/main.js": 'import { q } from "./b.js?v=2";\nexport const y = q;',
			"js/b.js": "export const q = 1;",
		});
		expect(() => bundleFrontend({ webDir: dir3 })).toThrow(/查询/);
	});

	it("说明符解析拒绝跳出 web 根、未知绝对路径与未知裸名", () => {
		expect(() => resolveSpecifier("../../etc/passwd", "js/main.js", webDir)).toThrow();
		expect(() => resolveSpecifier("/something/x.js", "js/main.js", webDir)).toThrow(/file:\/\//);
		expect(() => resolveSpecifier("definitely-not-a-package", "js/main.js", webDir)).toThrow();
	});

	it("未知后缀等所有模块问题都会让打包抛错（含循环引用不到的文件）", () => {
		const dir = makeTempWebDir({
			"js/main.js": 'import { x } from "./a.js";\nimport { z } from "./missing.js";\nexport const y = x + z;',
			"js/a.js": "export const x = 1;",
		});
		expect(() => bundleFrontend({ webDir: dir })).toThrow(/missing\.js/);
	});
});

describe("W22 (e) 扫描器小型单元用例", () => {
	it('字符串、模板字符串、注释、正则里出现的 import "x" 不被误扫', () => {
		const tick = "`";
		const source = [
			'const a = "import \\"x\\"";',
			"const b = 'import \"y\"';",
			`const c = ${tick}import "z"${tick};`,
			'const commentLine = "// import \\"w\\"";',
			'// import "line"',
			'/* import "block" */',
			'const re = /import "regex"/;',
			'const div = 10 / 2 / 5; // import "after-div"',
			`const nested = ${tick}outer \${ ${tick}inner \${ "import \\"deep\\"" } tail${tick} } end${tick};`,
			"export { a, b, c, nested };",
		].join("\n");
		expect(scanImports(source)).toEqual([]);
	});

	it("识别全部形态：static / 副作用 static / export-from / export * / export * as / dynamic", () => {
		const found = scanImports(
			[
				'import { a } from "./a.js";',
				'import "./side.js";',
				'export { b } from "./b.js";',
				'export * from "./star.js";',
				'export * as ns from "./ns.js";',
				'const m = await import("./dyn.js");',
			].join("\n"),
		);
		const kinds = new Map(found.map((f) => [f.specifier, f.kind]));
		expect(kinds.get("./a.js")).toBe("static");
		expect(kinds.get("./side.js")).toBe("static");
		expect(kinds.get("./b.js")).toBe("export-from");
		expect(kinds.get("./star.js")).toBe("export-from");
		expect(kinds.get("./ns.js")).toBe("export-from");
		expect(kinds.get("./dyn.js")).toBe("dynamic");
		// 区间指向说明符本体（不含引号）。
		const src = [
			'import { a } from "./a.js";',
			'import "./side.js";',
			'export { b } from "./b.js";',
			'export * from "./star.js";',
			'export * as ns from "./ns.js";',
			'const m = await import("./dyn.js");',
		].join("\n");
		for (const hit of scanImports(src)) {
			expect(src.slice(hit.start, hit.end)).toBe(hit.specifier);
		}
	});

	it("点号属性 .import / .export 不是关键字；多行子句与子句内注释不误伤", () => {
		expect(scanImports('obj.import("./x.js");\nobj?.export("./y.js");')).toEqual([]);
		const multi = [
			'import {\n\ta, // import "trap"\n\tb as c,\n} /* before from */ from "./m.js";',
			"export const z = c;",
		].join("\n");
		const found = scanImports(multi);
		expect(found.map((f) => f.specifier)).toEqual(["./m.js"]);
		expect(found[0]!.kind).toBe("static");
	});

	it("重写产物再扫一遍：说明符都变成裸名，且区间不变量在全部真实模块上成立", () => {
		const bundle = getRealBundle();
		for (const m of bundle.modules.values()) {
			for (const hit of scanImports(m.source)) {
				expect(m.source.slice(hit.start, hit.end)).toBe(hit.specifier);
			}
		}
		for (const rel of listFrontendJsFiles()) {
			const source = readFileSync(join(webDir, rel), "utf8");
			for (const hit of scanImports(source)) {
				expect(source.slice(hit.start, hit.end)).toBe(hit.specifier);
			}
		}
	});
});
