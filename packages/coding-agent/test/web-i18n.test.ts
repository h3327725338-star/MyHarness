import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The Web UI language layer is plain ES modules; load them through computed URLs (they are browser modules).
const webDir = new URL("../web/js/", import.meta.url);
const i18n = await import(new URL("i18n.js", webDir).href);
const lang = await import(new URL("lang.js", webDir).href);
const { zhCN, zhUnits, serverTextEn, serverTextZh } = await import(new URL("locales/zh-CN.js", webDir).href);
const { formatData, effortName } = await import(new URL("util.js", webDir).href);

const files = readdirSync(webDir).filter((name) => name.endsWith(".js"));
const sources = new Map(files.map((name) => [name, readFileSync(new URL(name, webDir), "utf8")]));

const STRING = String.raw`"((?:[^"\\\n]|\\.)*)"`;
const CALL = new RegExp(String.raw`(?<![\w.$])(?:t|N_|tNodes)\(\s*${STRING}`, "g");
const UNIT = new RegExp(String.raw`(?<![\w$])(?:plural|count)\([^"'\`]*?,\s*${STRING}(?:\s*,\s*${STRING})?`, "g");

function keysUsed(): string[] {
	const found = new Set<string>();
	for (const text of sources.values()) for (const match of text.matchAll(CALL)) found.add(JSON.parse(`"${match[1]}"`));
	return [...found];
}

describe("Web UI: interface language", () => {
	it("has a Chinese entry for every translated text and counted noun", () => {
		const missing = keysUsed().filter((key) => !(key in zhCN));
		expect(missing).toEqual([]);
		const units = new Set<string>();
		for (const text of sources.values()) {
			for (const match of text.matchAll(UNIT)) {
				units.add(JSON.parse(`"${match[1]}"`));
			}
		}
		expect([...units].filter((unit) => !(unit in zhUnits))).toEqual([]);
	});

	it("keeps the same {placeholders} in every translation", () => {
		const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
		const mismatched = Object.entries(zhCN as Record<string, string>).filter(
			([key, value]) => names(key).join() !== names(value).join(),
		);
		expect(mismatched).toEqual([]);
	});

	it("keeps Chinese out of the interface code: it lives only in locales/zh-CN.js (and the language names)", () => {
		const cjk = /[　-鿿＀-￯]/u;
		const offenders: string[] = [];
		for (const [name, text] of sources) {
			if (name === "lang.js") continue; // the language names are written in their own language
			text.split("\n").forEach((line, index) => {
				if (cjk.test(line.replaceAll("简体中文", ""))) offenders.push(`${name}:${index + 1}`);
			});
		}
		expect(offenders).toEqual([]);
	});

	it("shows English text unchanged and Chinese text from the dictionary", () => {
		lang.setLang("en");
		expect(i18n.t("Settings")).toBe("Settings");
		expect(i18n.t("Worked for {duration}", { duration: "5s" })).toBe("Worked for 5s");
		expect(i18n.count(3, "file")).toBe("3 files");
		expect(i18n.count(1, "file")).toBe("1 file");
		lang.setLang("zh-CN");
		expect(i18n.t("Settings")).toBe("设置");
		expect(i18n.t("Worked for {duration}", { duration: "5秒" })).toBe("用时 5秒");
		expect(i18n.count(3, "file")).toBe("3 个文件");
		expect(i18n.t("A text that has no translation")).toBe("A text that has no translation");
		lang.setLang("en");
	});

	it("places elements inside translated sentences in each language's own word order", () => {
		lang.setLang("zh-CN");
		const nodes = i18n.tNodes("What should we work on in {workspace}?", { workspace: "<b>ws</b>" });
		expect(nodes.join("")).toBe("我们在 <b>ws</b> 中做点什么？");
		lang.setLang("en");
		expect(i18n.tNodes("What should we work on in {workspace}?", { workspace: "ws" }).join("")).toBe(
			"What should we work on in ws?",
		);
	});

	it("turns Chinese server text into English and never shows unknown Chinese in English mode", () => {
		lang.setLang("en");
		expect(i18n.serverText("正在请求模型")).toBe("Requesting the model");
		expect(i18n.serverText("正在重试 (2/3)")).toBe("Retrying (2/3)");
		expect(i18n.serverText("恢复检查点失败。")).toBe("Restoring the checkpoint failed.");
		expect(i18n.serverText("路径不存在：C:\\x")).toBe("The path does not exist: C:\\x");
		expect(i18n.serverText("完全没见过的中文消息", "fallback text")).toBe("fallback text");
		expect(i18n.serverText("Plain English stays", "fallback text")).toBe("Plain English stays");
		expect(i18n.serverText("", "fallback text")).toBe("fallback text");
		for (const [chinese, english] of Object.entries(serverTextEn.exact as Record<string, string>)) {
			expect(/[　-鿿]/u.test(english), `${chinese} -> ${english}`).toBe(false);
		}
	});

	it("turns English server text into Chinese, including messages with variable parts", () => {
		lang.setLang("zh-CN");
		expect(i18n.serverText("Steering messages")).toBe("引导消息");
		expect(i18n.serverText("Retry transient provider errors (up to 3 times).")).toBe(
			"遇到临时性的提供商错误时自动重试（最多 3 次）。",
		);
		expect(i18n.serverText("Trust parent folder (C:\\work)")).toBe("信任上级文件夹（C:\\work）");
		expect(i18n.serverText("30 sec")).toBe("30 秒");
		expect(serverTextZh.patterns.length).toBeGreaterThan(0);
		lang.setLang("en");
	});

	it("translates reasoning-effort level names and hints", () => {
		lang.setLang("zh-CN");
		expect(effortName("xhigh")).toBe("超高");
		expect(effortName("custom-level")).toBe("custom-level");
		lang.setLang("en");
		expect(effortName("xhigh")).toBe("xhigh");
	});
});

describe("Web UI: structured data display", () => {
	it("keeps real line breaks in multi-line values instead of showing a literal backslash-n", () => {
		const text = formatData({
			command: "echo one\necho two",
			timeout: 30,
			nested: { path: "a.ts", flags: ["-a", "-b"] },
		});
		expect(text).toContain("command: |\n  echo one\n  echo two");
		expect(text).toContain("timeout: 30");
		expect(text).not.toContain("\\n");
		expect(text).toContain("nested:\n  path: a.ts\n  flags:\n    - -a\n    - -b");
	});

	it("shows plain strings, empty values and null as they are", () => {
		expect(formatData("just text")).toBe("just text");
		expect(formatData({})).toBe("{}");
		expect(formatData({ empty: "", none: null, list: [] })).toBe('empty: ""\nnone: null\nlist: []');
	});
});
