import { describe, expect, it } from "vitest";
import { buildGoogleHttpOptions } from "../src/api/google-http-options.ts";

describe("Google HTTP option mapping", () => {
	it("disables implicit SDK retries when no provider retry count is configured", () => {
		expect(buildGoogleHttpOptions({ baseUrl: "https://example.invalid" })).toEqual({
			baseUrl: "https://example.invalid",
			retryOptions: { attempts: 1 },
		});
	});

	it("maps timeout and additional retries to Google SDK semantics", () => {
		expect(buildGoogleHttpOptions({ headers: { "x-test": "1" } }, { timeoutMs: 12_345, maxRetries: 2 })).toEqual({
			headers: { "x-test": "1" },
			timeout: 12_345,
			retryOptions: { attempts: 3 },
		});
	});

	it("normalizes invalid and fractional retry values without enabling hidden retries", () => {
		expect(buildGoogleHttpOptions(undefined, { maxRetries: -4.8 })).toEqual({ retryOptions: { attempts: 1 } });
		expect(buildGoogleHttpOptions(undefined, { maxRetries: Number.NaN })).toEqual({ retryOptions: { attempts: 1 } });
	});
});
