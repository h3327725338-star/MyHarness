import { describe, expect, it } from "vitest";
import {
	buildLineIndex,
	identifierRangeAt,
	locateDeclarationName,
	offsetAt,
	positionAt,
} from "../../../src/symbols/semantic/locator.ts";
import type { CodeRange, CodeSymbolKind } from "../../../src/symbols/types.ts";

/** Whole-text range, i.e. what a flat SymbolInformation location looks like for a one-declaration snippet. */
function wholeRange(text: string): CodeRange {
	const index = buildLineIndex(text);
	return { start: { line: 0, character: 0 }, end: positionAt(index, text.length) };
}

function slice(text: string, range: CodeRange): string {
	const index = buildLineIndex(text);
	return text.slice(offsetAt(index, range.start), offsetAt(index, range.end));
}

function locate(text: string, name: string, kind: CodeSymbolKind, languageId = "typescript") {
	return locateDeclarationName({ text, declaration: wholeRange(text), name, kind, languageId });
}

describe("locateDeclarationName", () => {
	it("finds the class name after export and keeps the declaration start out of the selection", () => {
		const text = "export class LanguageServerManager {\n  run() {}\n}\n";
		const result = locate(text, "LanguageServerManager", "class");
		expect(result.status).toBe("located");
		if (result.status !== "located") return;
		expect(result.range).toEqual({ start: { line: 0, character: 13 }, end: { line: 0, character: 34 } });
		expect(slice(text, result.range)).toBe("LanguageServerManager");
	});

	it("is not fooled by a decorator that has the same name or by comments", () => {
		const text = "// class Foo is documented here\n@Foo({ name: 'Foo' })\nexport class Foo {}\n";
		const result = locate(text, "Foo", "class");
		expect(result.status).toBe("located");
		if (result.status !== "located") return;
		expect(result.range.start.line).toBe(2);
		expect(slice(text, result.range)).toBe("Foo");
	});

	it("handles modifiers named like the method and return types that repeat the name", () => {
		const getter = "get get() { return 1; }";
		const found = locate(getter, "get", "method");
		expect(found.status).toBe("located");
		if (found.status === "located") expect(found.range.start.character).toBe(4);

		const repeated = "function parse(input: parse): parse { return input; }";
		const second = locate(repeated, "parse", "function");
		expect(second.status).toBe("located");
		if (second.status === "located") expect(second.range.start.character).toBe(9);
	});

	it("locates string-literal method names and computed keys", () => {
		const quoted = '  "my-method"(value: string): void {}';
		const found = locate(quoted, '"my-method"', "method");
		expect(found.status).toBe("located");
		if (found.status === "located") {
			expect(slice(quoted, found.range)).toBe('"my-method"');
			expect(found.tokenKind).toBe("string");
		}
		const unquotedName = locate(quoted, "my-method", "method");
		expect(unquotedName.status).toBe("located");

		const computed = "  [Symbol.iterator]() { return [][Symbol.iterator](); }";
		const key = locate(computed, "[Symbol.iterator]", "method");
		expect(key.status).toBe("located");
		if (key.status === "located") expect(slice(computed, key.range)).toBe("[Symbol.iterator]");
	});

	it("does not invent a name for an anonymous default export", () => {
		expect(locate("export default class {\n  run() {}\n}\n", "Foo", "class").status).toBe("not_found");
		const anonymous = locate("export default function () { return 1; }", "default", "function");
		expect(anonymous.status).toBe("located");
	});

	it("reports ambiguity instead of picking one of several equal tokens", () => {
		const text = "declare class Twin extends Twin {}\n";
		const result = locate(text, "Twin", "class");
		// The keyword rule resolves the real declaration name even though the heritage clause repeats it.
		expect(result.status).toBe("located");
		const unrelated = locate("int foo bar foo baz", "foo", "variable", "cpp");
		expect(unrelated.status).toBe("ambiguous");
	});

	it("counts UTF-16 code units for non-BMP characters and keeps CRLF lines apart", () => {
		const text = "const note = '😀😀';\r\nexport function 名前(value: number) {\r\n  return value;\r\n}\r\n";
		const declaration: CodeRange = { start: { line: 1, character: 0 }, end: { line: 3, character: 1 } };
		const result = locateDeclarationName({
			text,
			declaration,
			name: "名前",
			kind: "function",
			languageId: "typescript",
		});
		expect(result.status).toBe("located");
		if (result.status !== "located") return;
		expect(result.range).toEqual({ start: { line: 1, character: 16 }, end: { line: 1, character: 18 } });

		const emoji = "const 😀 = 1; export class Emoji {}";
		const declarationStart = emoji.indexOf("export");
		const located = locateDeclarationName({
			text: emoji,
			declaration: { start: { line: 0, character: declarationStart }, end: { line: 0, character: emoji.length } },
			name: "Emoji",
			kind: "class",
			languageId: "typescript",
		});
		expect(located.status).toBe("located");
		if (located.status === "located") {
			// "😀" occupies two UTF-16 code units, so the column is not the code point index.
			expect(located.range.start.character).toBe(emoji.indexOf("Emoji"));
			expect(emoji.codePointAt(emoji.indexOf("😀"))).toBeGreaterThan(0xffff);
			expect(slice(emoji, located.range)).toBe("Emoji");
		}
	});

	it("separates two declarations on the same line by their own ranges", () => {
		const text = "function one() {} function two() {}";
		const first = locateDeclarationName({
			text,
			declaration: { start: { line: 0, character: 0 }, end: { line: 0, character: 17 } },
			name: "one",
			kind: "function",
			languageId: "typescript",
		});
		const second = locateDeclarationName({
			text,
			declaration: { start: { line: 0, character: 18 }, end: { line: 0, character: 35 } },
			name: "two",
			kind: "function",
			languageId: "typescript",
		});
		expect(first.status).toBe("located");
		expect(second.status).toBe("located");
		if (first.status === "located" && second.status === "located") {
			expect(first.range.start.character).toBe(9);
			expect(second.range.start.character).toBe(27);
		}
	});

	it("locates names in python and rust declarations", () => {
		const python = "@decorator\nclass Service(Base):\n    def run(self):\n        pass\n";
		const klass = locate(python, "Service", "class", "python");
		expect(klass.status).toBe("located");
		if (klass.status === "located") expect(klass.range.start).toEqual({ line: 1, character: 6 });

		const rust = "pub fn run<'a>(value: &'a str) -> &'a str {\n    value\n}\n";
		const fn = locate(rust, "run", "function", "rust");
		expect(fn.status).toBe("located");
		if (fn.status === "located") expect(fn.range.start.character).toBe(7);
	});

	it("falls back to a unique text match for operator-like names and refuses repeated ones", () => {
		const text = "bool operator==(const A& a, const A& b);";
		const found = locate(text, "operator==", "operator", "cpp");
		expect(found.status).toBe("located");
		const twice = "operator==(operator==)";
		expect(locate(twice, "operator==", "operator", "cpp").status).toBe("ambiguous");
	});
});

describe("line index helpers", () => {
	it("maps offsets and positions for LF, CRLF and CR", () => {
		const text = "ab\r\ncd\nef\rgh";
		const index = buildLineIndex(text);
		expect(index.starts).toEqual([0, 4, 7, 10]);
		expect(positionAt(index, 5)).toEqual({ line: 1, character: 1 });
		expect(offsetAt(index, { line: 3, character: 1 })).toBe(11);
		expect(offsetAt(index, { line: 9, character: 0 })).toBeUndefined();
	});

	it("finds the identifier under a position", () => {
		const range = identifierRangeAt("let value = other;", { line: 0, character: 5 }, "typescript");
		expect(range).toEqual({ start: { line: 0, character: 4 }, end: { line: 0, character: 9 } });
		expect(identifierRangeAt("let  = 1", { line: 0, character: 4 }, "typescript")).toBeUndefined();
	});
});
