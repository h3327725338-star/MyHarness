import { describe, expect, test } from "vitest";
import { filterContextForAgentRole } from "../src/context/context-policy.ts";

const mainOperationBlock = `<!-- myharness:main-operation -->
Main Agent must wait for user ok.
<!-- /myharness:main-operation -->`;

describe("context policy", () => {
	test("keeps shared context and removes Main-Agent-only blocks for delegated sessions", () => {
		const content = `Shared project rule.\n${mainOperationBlock}\nTechnical detail.`;

		const filtered = filterContextForAgentRole(content, "delegated");

		expect(filtered).toContain("Shared project rule.");
		expect(filtered).toContain("Technical detail.");
		expect(filtered).not.toContain("Main Agent must wait for user ok.");
		expect(filtered).not.toContain("myharness:main-operation");
	});

	test("keeps Main-Agent-only content for Main and removes marker lines", () => {
		const filtered = filterContextForAgentRole(`Before\n${mainOperationBlock}\nAfter`, "main");

		expect(filtered).toContain("Main Agent must wait for user ok.");
		expect(filtered).toContain("Before");
		expect(filtered).toContain("After");
		expect(filtered).not.toContain("myharness:main-operation");
	});

	test("does not discard an unmarked technical rule", () => {
		const content = "The delegated Agent may inspect TypeScript source files.";

		expect(filterContextForAgentRole(content, "delegated")).toBe(content);
	});
});
