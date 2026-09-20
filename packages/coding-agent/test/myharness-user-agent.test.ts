import { describe, expect, it } from "vitest";
import { getMyHarnessUserAgent } from "../src/utils/myharness-user-agent.ts";

describe("getMyHarnessUserAgent", () => {
	it("formats the MyHarness user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getMyHarnessUserAgent("1.2.3");

		expect(userAgent).toBe(`myharness/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^myharness\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
