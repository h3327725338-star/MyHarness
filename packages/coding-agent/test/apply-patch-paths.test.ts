import { describe, expect, it } from "vitest";
import { applyPatchPaths } from "../src/tools/files/apply-patch-parser.ts";

describe("applyPatchPaths", () => {
	it("names added, deleted and updated files in the order the operations appear", () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: added.ts",
			"+fresh",
			"*** Delete File: gone.ts",
			"*** Update File: changed.ts",
			"@@",
			" keep",
			"-old",
			"+new",
			"*** End Patch",
		].join("\n");

		expect(applyPatchPaths(patch)).toEqual(["added.ts", "gone.ts", "changed.ts"]);
	});

	it("names both ends of a move, the source first and the target after it", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: old.ts",
			"*** Move to: new.ts",
			"@@",
			" alpha",
			"+beta",
			"*** End Patch",
		].join("\n");

		expect(applyPatchPaths(patch)).toEqual(["old.ts", "new.ts"]);
	});

	it("keeps the order and the count of every path in a mixed patch that contains a move", () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: a.ts",
			"+one",
			"*** Update File: b.ts",
			"*** Move to: c.ts",
			"*** Delete File: d.ts",
			"*** Update File: e.ts",
			"@@",
			" keep",
			"+more",
			"*** End Patch",
		].join("\n");

		expect(applyPatchPaths(patch)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
	});

	it("names no path for a patch that has no file operations", () => {
		expect(applyPatchPaths(["*** Begin Patch", "*** End Patch"].join("\n"))).toEqual([]);
	});

	it("names no path, and does not throw, for text that does not parse", () => {
		expect(applyPatchPaths("not a patch")).toEqual([]);
		const missingEnd = ["*** Begin Patch", "*** Update File: a.ts", "@@", " keep", "+new"].join("\n");
		expect(applyPatchPaths(missingEnd)).toEqual([]);
	});

	it("names no path for a value that is not text", () => {
		expect(applyPatchPaths(undefined)).toEqual([]);
		expect(applyPatchPaths(123)).toEqual([]);
		expect(applyPatchPaths({})).toEqual([]);
	});

	it("returns a leading @ in a path as written, because the shared function does not resolve paths", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: @old.ts",
			"*** Move to: @new.ts",
			"*** Add File: @added.ts",
			"+fresh",
			"*** End Patch",
		].join("\n");

		expect(applyPatchPaths(patch)).toEqual(["@old.ts", "@new.ts", "@added.ts"]);
	});
});
