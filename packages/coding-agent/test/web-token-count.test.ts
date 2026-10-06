import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("Web UI: formatSessionTokenCount", () => {
	const source = readFileSync(new URL("../web/js/panel-context.js", import.meta.url), "utf8");
	const context = vm.createContext({
		N_: (s: string) => s,
		t: (s: string) => s,
		fmtTokens: (n: number | null | undefined) => {
			if (n == null || !Number.isFinite(n)) return "—";
			if (n < 1000) return String(Math.round(n));
			if (n < 999_950) return `${(n / 1000).toFixed(1)}K`;
			return `${(n / 1_000_000).toFixed(1)}M`;
		},
	});
	vm.runInContext(source.replace(/^import .*;\r?\n/gm, "").replace(/^export (?:default )?/gm, ""), context);
	const formatSessionTokenCount = (context as any).formatSessionTokenCount;

	it("returns dash for undetected cache write when value is 0", () => {
		const stats = {
			tokens: { input: 51300, output: 1500, cacheRead: 247200, cacheWrite: 0, total: 300000 },
			tokenAvailability: { input: true, output: true, cacheRead: true, cacheWrite: false },
			cache: {
				write: { value: null, estimated: false },
				read: { value: 247200, estimated: false },
				input: { value: 51300, estimated: false },
			},
		};
		expect(formatSessionTokenCount(stats, "cacheWrite")).toBe("—");
		expect(formatSessionTokenCount(stats, "cacheRead")).toBe("247.2K");
		expect(formatSessionTokenCount(stats, "input")).toBe("51.3K");
		expect(formatSessionTokenCount(stats, "output")).toBe("1.5K");
	});

	it("returns formatted count when cache write is explicitly detected and reported", () => {
		const stats = {
			tokens: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 200, total: 1800 },
			tokenAvailability: { input: true, output: true, cacheRead: true, cacheWrite: true },
			cache: {
				write: { value: 200, estimated: false },
				read: { value: 500, estimated: false },
				input: { value: 1000, estimated: false },
			},
		};
		expect(formatSessionTokenCount(stats, "cacheWrite")).toBe("200");
	});

	it("returns zero when cache write is explicitly detected and reported as zero", () => {
		const stats = {
			tokens: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 0, total: 1600 },
			tokenAvailability: { input: true, output: true, cacheRead: true, cacheWrite: true },
			cache: {
				write: { value: 0, estimated: false },
				read: { value: 500, estimated: false },
				input: { value: 1000, estimated: false },
			},
		};
		expect(formatSessionTokenCount(stats, "cacheWrite")).toBe("0");
	});

	it("returns dash when stats.cache is absent and tokenAvailability is false", () => {
		const stats = {
			tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
			tokenAvailability: { input: true, output: true, cacheRead: true, cacheWrite: false },
		};
		expect(formatSessionTokenCount(stats, "cacheWrite")).toBe("—");
		expect(formatSessionTokenCount(stats, "cacheRead")).toBe("0");
		expect(formatSessionTokenCount(stats, "input")).toBe("100");
		expect(formatSessionTokenCount(stats, "output")).toBe("10");
	});

	it("returns dash for all metrics in an empty session", () => {
		const stats = {
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			tokenAvailability: { input: false, output: false, cacheRead: false, cacheWrite: false },
			cache: {
				write: { value: null, estimated: false },
				read: { value: null, estimated: false },
				input: { value: null, estimated: false },
			},
		};
		expect(formatSessionTokenCount(stats, "input")).toBe("—");
		expect(formatSessionTokenCount(stats, "output")).toBe("—");
		expect(formatSessionTokenCount(stats, "cacheRead")).toBe("—");
		expect(formatSessionTokenCount(stats, "cacheWrite")).toBe("—");
	});

	it("preserves positive token count even if session availability flag is false", () => {
		const stats = {
			tokens: { input: 200, output: 50, cacheRead: 100, cacheWrite: 50, total: 400 },
			tokenAvailability: { input: false, output: false, cacheRead: false, cacheWrite: false },
		};
		expect(formatSessionTokenCount(stats, "input")).toBe("200");
		expect(formatSessionTokenCount(stats, "output")).toBe("50");
		expect(formatSessionTokenCount(stats, "cacheRead")).toBe("100");
		expect(formatSessionTokenCount(stats, "cacheWrite")).toBe("50");
	});

	it("returns dash for invalid or negative token values", () => {
		expect(formatSessionTokenCount({ tokens: { input: -1 } }, "input")).toBe("—");
		expect(formatSessionTokenCount({ tokens: {} }, "input")).toBe("—");
		expect(formatSessionTokenCount(null, "input")).toBe("—");
	});
});
