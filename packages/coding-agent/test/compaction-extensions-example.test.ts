import { describe, expect, it } from "vitest";
import example from "../examples/extensions/custom-compaction.ts";
import type { ExtensionAPI } from "../src/extensions/compat/index.ts";

describe("Compaction lifecycle example", () => {
	it("registers notifications rather than a replacement compressor", () => {
		const handlers: string[] = [];
		example({ on: (name: string) => handlers.push(name) } as unknown as ExtensionAPI);
		expect(handlers).toEqual(["session_before_compact", "session_compact"]);
	});
});
