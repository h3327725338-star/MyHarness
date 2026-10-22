import { describe, expect, it } from "vitest";
import { mergeMemoryText } from "../src/sync/memory-merge.ts";

const merge = (base: string | undefined, left: string, right: string) => mergeMemoryText(base, left, right);

describe("memory merge", () => {
	it("keeps edits made on different lines of the same memory", () => {
		const base = "# Profile\n- lives in Subang Jaya\n- studies Computer Science\n";
		const local = "# Profile\n- lives in Subang Jaya\n- studies Computer Science\n- trains five times a week\n";
		const remote = "# Profile\n- lives in Subang Jaya, USJ1\n- studies Computer Science\n";
		const result = merge(base, local, remote);
		expect(result.text).toContain("USJ1");
		expect(result.text).toContain("trains five times a week");
	});

	it("produces the same text no matter which device runs the merge", () => {
		const base = "# Notes\n- one\n- two\n- three\n";
		const left = "# Notes\n- one\n- two edited on desktop\n- three\n- four\n";
		const right = "# Notes\n- one\n- two edited on laptop\n- three\n- five\n";
		const a = merge(base, left, right);
		const b = merge(base, right, left);
		expect(a.text).toBe(b.text);
		expect(a.text).toContain("four");
		expect(a.text).toContain("five");
	});

	it("keeps the more detailed side instead of duplicating it", () => {
		const base = "# Profile\n- one\n";
		const short = "# Profile\n- one\n- two\n";
		const detailed = "# Profile\n- one\n- two\n- three\n- four\n";
		expect(merge(base, short, detailed).text).toBe(detailed);
		expect(merge(base, detailed, short).text).toBe(detailed);
	});

	it("merges without a base by anchoring on the common lines", () => {
		const left = "# Profile\n- name\n- lives in Subang Jaya\n- trains daily\n";
		const right = "# Profile\n- name\n- lives in Subang Jaya\n- studies AI\n";
		const forward = merge(undefined, left, right);
		const backward = merge(undefined, right, left);
		expect(forward.text).toBe(backward.text);
		expect(forward.text).toContain("trains daily");
		expect(forward.text).toContain("studies AI");
		expect(forward.text).not.toContain("# Profile\n# Profile");
	});

	it("merges frontmatter by field instead of duplicating keys", () => {
		const base =
			"---\nid: global/profile\nupdatedAt: 2026-01-01T00:00:00.000Z\ntriggers:\n  - one\n---\n# Profile\n- base\n";
		const local =
			"---\nid: global/profile\nupdatedAt: 2026-02-01T00:00:00.000Z\ntriggers:\n  - one\n  - two\n---\n# Profile\n- base\n- local line\n";
		const remote =
			"---\nid: global/profile\nupdatedAt: 2026-02-02T00:00:00.000Z\ntriggers:\n  - one\n  - three\n---\n# Profile\n- base\n- remote line\n";
		const merged = merge(base, local, remote).text;
		const header = merged.split("---")[1]!;
		expect(header.match(/^updatedAt:/gmu)).toHaveLength(1);
		expect(header).toContain("2026-02-02T00:00:00.000Z");
		expect(header).toContain("  - two");
		expect(header).toContain("  - three");
		expect(merged).toContain("local line");
		expect(merged).toContain("remote line");
	});

	it("chooses the same frontmatter value on both devices", () => {
		const base = "---\nname: profile\ndescription: short\n---\n# Profile\n";
		const left = "---\nname: profile\ndescription: the longer description from this side\n---\n# Profile\n";
		const right = "---\nname: profile\ndescription: another description\n---\n# Profile\n";
		const forward = merge(base, left, right).text;
		const backward = merge(base, right, left).text;
		expect(forward).toBe(backward);
		expect(forward).toContain("the longer description from this side");
	});

	it("is idempotent once both sides are merged", () => {
		const base = "# Profile\n- a\n- b\n";
		const left = "# Profile\n- a\n- b\n- c\n";
		const right = "# Profile\n- a changed\n- b\n";
		const first = merge(base, left, right);
		const second = merge(base, first.text, right);
		expect(second.text).toBe(first.text);
	});

	it("does nothing when both sides are equal", () => {
		const text = "# Profile\n- a\n";
		const result = merge("# Profile\n", text, text);
		expect(result.changed).toBe(false);
		expect(result.text).toBe(text);
	});
});
