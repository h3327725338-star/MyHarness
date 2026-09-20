import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/application/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.MYHARNESS_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.MYHARNESS_EXPERIMENTAL;
		} else {
			process.env.MYHARNESS_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when MYHARNESS_EXPERIMENTAL is unset", () => {
		delete process.env.MYHARNESS_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when MYHARNESS_EXPERIMENTAL is empty", () => {
		process.env.MYHARNESS_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when MYHARNESS_EXPERIMENTAL is set to 1", () => {
		process.env.MYHARNESS_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when MYHARNESS_EXPERIMENTAL is set to 0", () => {
		process.env.MYHARNESS_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when MYHARNESS_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.MYHARNESS_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
