/**
 * Malformed and adversarial patch *text*: how the apply_patch parser answers markers it does not recognise,
 * invisible characters, mixed line endings and empty sections. Pure functions, no filesystem access.
 *
 * N06-H2 companion to test/apply-patch.test.ts, which covers the well-formed shapes and the plain
 * "missing Begin/End", "bad line prefix", "empty hunk" rejections.
 */
import { describe, expect, it } from "vitest";
import { applyPatchPaths, parseApplyPatch } from "../src/tools/files/apply-patch-parser.ts";

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const END_OF_FILE = "*** End of File";

function patch(...lines: string[]): string {
	return lines.join("\n");
}

function parseError(patchText: string): string {
	try {
		parseApplyPatch(patchText);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error(`expected the parser to reject this patch: ${JSON.stringify(patchText.slice(0, 60))}`);
}

describe("apply_patch parser: marker spelling variants", () => {
	it("accepts trailing whitespace on the Begin and End marker lines", () => {
		const operations = parseApplyPatch(patch(`${BEGIN}   `, "*** Add File: a.txt ", "+x", `${END}  `));
		expect(operations).toEqual([{ type: "add", path: "a.txt", content: "x\n", line: 2 }]);
	});

	it("rejects an indented or tab-prefixed marker line, because the marker must start the line", () => {
		expect(parseError(patch(`   ${BEGIN}`, "*** Add File: a.txt", "+x", END))).toMatch(/must start with/);
		expect(parseError(patch(`\t${BEGIN}`, "*** Add File: a.txt", "+x", END))).toMatch(/must start with/);
	});

	it("rejects a marker whose case differs and names the marker the first line has to be", () => {
		const message = parseError(patch("*** begin Patch", "*** Add File: a.txt", "+x", END));
		expect(message).toContain('"*** Begin Patch"');
		expect(message).toContain("line 1");
	});

	it("rejects an End marker whose case differs instead of ending the patch", () => {
		expect(parseError(patch(BEGIN, "*** Add File: a.txt", "+x", "*** end patch"))).toMatch(
			/unknown or misplaced directive/,
		);
	});

	it("rejects a byte order mark in front of the Begin marker instead of skipping it", () => {
		expect(parseError(`\uFEFF${patch(BEGIN, "*** Add File: a.txt", "+x", END)}`)).toMatch(/must start with/);
	});

	it("rejects markers that differ only by an invisible character", () => {
		// A zero width space inside the directive word.
		expect(parseError(patch(BEGIN, "*** Add\u200b File: a.txt", "+x", END))).toMatch(
			/unknown or misplaced directive/,
		);
		// A non-breaking space instead of the space between "Begin" and "Patch".
		expect(parseError(patch("*** Begin\u00A0Patch", "*** Add File: a.txt", "+x", END))).toMatch(/must start with/);
	});

	it("rejects a directive written without its colon", () => {
		expect(parseError(patch(BEGIN, "*** Add File a.txt", "+x", END))).toMatch(/unknown or misplaced directive/);
	});

	it("rejects a second Begin marker inside one patch", () => {
		expect(parseError(patch(BEGIN, "*** Add File: a.txt", "+x", BEGIN, END))).toMatch(
			/unknown or misplaced directive/,
		);
	});

	it("rejects an End-of-File marker that comes before any hunk line", () => {
		expect(parseError(patch(BEGIN, "*** Update File: a.txt", END_OF_FILE, END))).toMatch(
			/must come after the lines of a hunk/,
		);
	});

	it("reports the line number of the line it rejected", () => {
		const message = parseError(patch(BEGIN, "*** Add File: a.txt", "+x", END, "leftover"));
		expect(message).toContain("line 5");
		expect(message).toMatch(/nothing may follow/);
	});
});

describe("apply_patch parser: empty and blank sections", () => {
	it("rejects an empty patch, a blank patch and a marker-only patch with distinct messages", () => {
		expect(() => parseApplyPatch("")).toThrow(/the patch is empty/);
		expect(() => parseApplyPatch("   \n\n  ")).toThrow(/the patch is empty/);
		expect(() => parseApplyPatch(patch(BEGIN, END))).toThrow(/contains no file operations/);
	});

	it("rejects a directive written with no space after the colon", () => {
		// The directive is "*** Add File: " with a trailing space, so "*** Add File:" is not a directive at all.
		expect(parseError(patch(BEGIN, "*** Add File:", "+x", END))).toMatch(/unknown or misplaced directive/);
		expect(parseError(patch(BEGIN, "*** Update File:", "@@", " x", END))).toMatch(/unknown or misplaced directive/);
	});

	it("rejects a directive whose path is only spaces", () => {
		expect(parseError(patch(BEGIN, "*** Add File:     ", "+x", END))).toMatch(/must be followed by a file path/);
		expect(parseError(patch(BEGIN, "*** Delete File:  \t ", "*** End Patch"))).toMatch(
			/must be followed by a file path/,
		);
	});

	it("trims the spaces around a path but keeps the spaces inside it", () => {
		const [operation] = parseApplyPatch(patch(BEGIN, "*** Add File:   my dir/hello world.txt ", "+x", END));
		expect(operation).toMatchObject({ type: "add", path: "my dir/hello world.txt" });
	});

	it("accepts an Add File section with no content lines as an empty file", () => {
		const [operation] = parseApplyPatch(patch(BEGIN, "*** Add File: empty.txt", END));
		expect(operation).toMatchObject({ type: "add", path: "empty.txt", content: "" });
	});

	it("keeps a body line of an Add File section that merely looks like a directive", () => {
		const [operation] = parseApplyPatch(
			patch(BEGIN, "*** Add File: notes.txt", "+*** End Patch", "+*** Add File: trick.txt", "+plain", END),
		);
		expect(operation).toMatchObject({
			type: "add",
			path: "notes.txt",
			content: "*** End Patch\n*** Add File: trick.txt\nplain\n",
		});
	});

	it("rejects a body line of an Add File section that lost its plus sign", () => {
		expect(parseError(patch(BEGIN, "*** Add File: a.txt", "+x", "forgot the plus", END))).toMatch(
			/must start with "\+"/,
		);
	});

	it("rejects a hunk whose only content is an @@ locating text", () => {
		expect(parseError(patch(BEGIN, "*** Update File: a.txt", "@@ function f() {", END))).toMatch(
			/this hunk has no lines/,
		);
	});
});

describe("apply_patch parser: line endings inside the patch text", () => {
	it("accepts a patch written entirely with CRLF", () => {
		expect(parseApplyPatch("*** Begin Patch\r\n*** Add File: a.txt\r\n+x\r\n*** End Patch\r\n")).toEqual([
			{ type: "add", path: "a.txt", content: "x\n", line: 2 },
		]);
	});

	it("accepts a patch that mixes CRLF and LF line endings", () => {
		expect(parseApplyPatch("*** Begin Patch\r\n*** Add File: a.txt\n+x\r\n*** End Patch")).toEqual([
			{ type: "add", path: "a.txt", content: "x\n", line: 2 },
		]);
	});

	it("treats a lone carriage return as part of the line, not as a line break", () => {
		// The parser splits on \r\n or \n only, so "x\ry" stays one hunk line and keeps its \r.
		const [operation] = parseApplyPatch(patch(BEGIN, "*** Update File: a.txt", "-x\ry", "+z", END));
		expect(operation).toMatchObject({
			type: "update",
			hunks: [
				{
					lines: [
						{ kind: "-", text: "x\ry" },
						{ kind: "+", text: "z" },
					],
				},
			],
		});
	});
});

describe("apply_patch parser: hostile paths stay text until the tool resolves them", () => {
	it("returns the path exactly as written for the shapes a shell or the Win32 layer would rewrite", () => {
		const cases: Array<[string, string]> = [
			["../escape.txt", "../escape.txt"],
			["C:foo", "C:foo"],
			["\\\\server\\share\\x.txt", "\\\\server\\share\\x.txt"],
			["\\\\?\\C:\\somewhere\\x.txt", "\\\\?\\C:\\somewhere\\x.txt"],
			["CON", "CON"],
			["a.txt:secret", "a.txt:secret"],
			["dot.txt.", "dot.txt."],
			["~/home.txt", "~/home.txt"],
			["@/at.txt", "@/at.txt"],
			["nul.txt", "nul.txt"],
			["a\u0000b.txt", "a\u0000b.txt"],
			["sub/../../up.txt", "sub/../../up.txt"],
		];
		for (const [written, expected] of cases) {
			const [operation] = parseApplyPatch(patch(BEGIN, `*** Add File: ${written}`, "+x", END));
			expect(operation?.path, written).toBe(expected);
		}
	});

	it("keeps a trailing dot in a path, so alias.txt and alias.txt. parse as two different strings", () => {
		const operations = parseApplyPatch(
			patch(BEGIN, "*** Add File: alias.txt", "+one", "*** Add File: alias.txt.", "+two", END),
		);
		expect(operations.map((operation) => operation.path)).toEqual(["alias.txt", "alias.txt."]);
	});

	it("trims a trailing-space spelling onto the plain name, so the parser cannot tell them apart", () => {
		const operations = parseApplyPatch(
			patch(BEGIN, "*** Add File: sp.txt", "+one", "*** Add File: sp.txt   ", "+two", END),
		);
		expect(operations.map((operation) => operation.path)).toEqual(["sp.txt", "sp.txt"]);
	});
});

describe("applyPatchPaths against malformed text", () => {
	it("names no path for every malformed marker variant instead of throwing", () => {
		const malformed = [
			"",
			"   \n",
			`\uFEFF${patch(BEGIN, "*** Add File: a.txt", "+x", END)}`,
			patch("*** begin Patch", "*** Add File: a.txt", "+x", END),
			patch(BEGIN, "*** Add File: a.txt", "+x"),
			patch(BEGIN, "*** Add\u200b File: a.txt", "+x", END),
			patch(BEGIN, "*** Add File:", "+x", END),
			patch(BEGIN, "hello", END),
			patch(BEGIN, END),
		];
		for (const patchText of malformed) {
			expect(applyPatchPaths(patchText), JSON.stringify(patchText.slice(0, 30))).toEqual([]);
		}
	});

	it("names the hostile paths of a parseable patch exactly as they were written", () => {
		const patchText = patch(
			BEGIN,
			"*** Add File: ../up.txt",
			"+x",
			"*** Delete File: CON",
			"*** Update File: a.txt:secret",
			"*** Move to: \\\\?\\C:\\somewhere\\b.txt",
			"@@",
			" keep",
			END,
		);
		expect(applyPatchPaths(patchText)).toEqual(["../up.txt", "CON", "a.txt:secret", "\\\\?\\C:\\somewhere\\b.txt"]);
	});
});
