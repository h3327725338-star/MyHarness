import { describe, expect, it } from "vitest";
import { ChangeControlError } from "../../src/changes/errors.ts";
import { applyTextEdits, lineStartOffsets, resolveTextEdits } from "../../src/changes/text-edits.ts";
import {
	decodeTextFile,
	detectLineEnding,
	encodeTextFile,
	sha256,
	withFileLineEnding,
} from "../../src/changes/text-file.ts";

function edit(startLine: number, startCharacter: number, endLine: number, endCharacter: number, newText: string) {
	return {
		range: { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } },
		newText,
	};
}

function codeOf(action: () => unknown): string | undefined {
	try {
		action();
	} catch (error) {
		return error instanceof ChangeControlError ? error.code : `other:${String(error)}`;
	}
	return undefined;
}

describe("applyTextEdits", () => {
	it("counts UTF-16 code units, so an emoji before the edit shifts the column by two", () => {
		const text = "const note = '😀'; export class Emoji {}\n";
		const column = text.indexOf("Emoji");

		expect(applyTextEdits(text, [edit(0, column, 0, column + 5, "Smile")], "a.ts")).toBe(
			"const note = '😀'; export class Smile {}\n",
		);
	});

	it("addresses lines of CRLF, LF and CR files alike", () => {
		for (const eol of ["\r\n", "\n", "\r"]) {
			const text = `first${eol}second${eol}third`;
			expect(applyTextEdits(text, [edit(1, 0, 1, 6, "2nd")], "a.ts")).toBe(`first${eol}2nd${eol}third`);
		}
		expect(lineStartOffsets("a\r\nb\rc\nd")).toEqual([0, 3, 5, 7]);
	});

	it("keeps same-point inserts in array order and puts an insert in front of a replacement that starts there", () => {
		const text = "abc";

		expect(applyTextEdits(text, [edit(0, 1, 0, 1, "X"), edit(0, 1, 0, 1, "Y")], "a.ts")).toBe("aXYbc");
		expect(applyTextEdits(text, [edit(0, 1, 0, 2, "R"), edit(0, 1, 0, 1, "I")], "a.ts")).toBe("aIRc");
	});

	it("allows adjacent edits and refuses overlapping ones", () => {
		expect(applyTextEdits("abcdef", [edit(0, 0, 0, 3, "X"), edit(0, 3, 0, 6, "Y")], "a.ts")).toBe("XY");
		expect(codeOf(() => applyTextEdits("abcdef", [edit(0, 0, 0, 4, "X"), edit(0, 3, 0, 6, "Y")], "a.ts"))).toBe(
			"INVALID_EDIT",
		);
	});

	it("refuses positions that do not fit the text instead of clamping them", () => {
		const text = "line one\nline two\n";

		expect(codeOf(() => applyTextEdits(text, [edit(0, 50, 0, 51, "x")], "a.ts"))).toBe("INVALID_EDIT");
		expect(codeOf(() => applyTextEdits(text, [edit(9, 0, 9, 1, "x")], "a.ts"))).toBe("INVALID_EDIT");
		expect(codeOf(() => applyTextEdits(text, [edit(0, 3, 0, 1, "x")], "a.ts"))).toBe("INVALID_EDIT");
		// The empty last line after the final line break is a real position.
		expect(applyTextEdits(text, [edit(2, 0, 2, 0, "tail")], "a.ts")).toBe("line one\nline two\ntail");
	});

	it("refuses a position inside a surrogate pair, which means the edit was computed for different text", () => {
		expect(codeOf(() => applyTextEdits("a😀b", [edit(0, 2, 0, 2, "x")], "a.ts"))).toBe("INVALID_EDIT");
	});

	it("reports what each edit replaces, for callers that verify it", () => {
		const resolved = resolveTextEdits("let value = 1;", [edit(0, 4, 0, 9, "other")], "a.ts");

		expect(resolved).toEqual([{ start: 4, end: 9, oldText: "value", newText: "other" }]);
	});

	it("gives inserted text the file's line ending when the file uses one throughout", () => {
		expect(applyTextEdits("a\r\nb\r\n", [edit(1, 0, 1, 0, "x\ny\n")], "a.ts", "\r\n")).toBe("a\r\nx\r\ny\r\nb\r\n");
		expect(applyTextEdits("a\nb\n", [edit(1, 0, 1, 0, "x\r\ny\r\n")], "a.ts", "\n")).toBe("a\nx\ny\nb\n");
		expect(withFileLineEnding("x\ny", undefined)).toBe("x\ny");
	});
});

describe("text files", () => {
	it("preserves a UTF-8 BOM and CRLF through decode and encode", () => {
		const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\r\n", "utf8")]);

		const decoded = decodeTextFile(bytes, "a.ts");

		expect(decoded).toMatchObject({ text: "a\r\nb\r\n", bom: "utf8", eol: "\r\n" });
		expect(encodeTextFile(decoded.text, decoded).equals(bytes)).toBe(true);
	});

	it("round-trips UTF-16 LE and BE with a byte order mark", () => {
		const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo\n", "utf16le")]);
		const be = Buffer.from(le);
		be.subarray(2).swap16();
		be[0] = 0xfe;
		be[1] = 0xff;

		for (const bytes of [le, be]) {
			const decoded = decodeTextFile(bytes, "a.txt");
			expect(decoded.text).toBe("héllo\n");
			expect(encodeTextFile(decoded.text, decoded).equals(bytes)).toBe(true);
		}
	});

	it("refuses invalid UTF-8 and binary data instead of guessing an encoding", () => {
		expect(codeOf(() => decodeTextFile(Buffer.from([0x61, 0xff, 0xfe, 0x62, 0x80]), "a.bin"))).toBe(
			"UNSUPPORTED_ENCODING",
		);
		expect(codeOf(() => decodeTextFile(Buffer.from([0x61, 0x00, 0x62]), "a.bin"))).toBe("UNSUPPORTED_ENCODING");
	});

	it("tells uniform line endings from mixed ones", () => {
		expect(detectLineEnding("a\nb\n")).toBe("\n");
		expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
		expect(detectLineEnding("a\r\nb\n")).toBeUndefined();
		expect(detectLineEnding("single line")).toBeUndefined();
	});

	it("hashes bytes, not text", () => {
		expect(sha256("abc")).toBe(sha256(Buffer.from("abc")));
		expect(sha256("abc")).not.toBe(sha256("abd"));
	});
});
