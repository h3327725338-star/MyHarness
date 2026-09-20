import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { CLI_HELP_SECTIONS, listCliHelpFlags, renderCliHelp } from "../src/cli/help.ts";

/** Valid sample value for flags whose value is validated further. */
const SAMPLE_VALUE: Record<string, string> = {
	mode: "json",
	thinking: "high",
	"agent-role": "main",
	"context-window": "256K",
};

describe("top-level CLI help", () => {
	test("renders a usage line with the app name", () => {
		const help = renderCliHelp();
		expect(help).toMatch(/^Usage: \S+ \[options\]/);
	});

	test("advertises the general, model and session flags", () => {
		const help = renderCliHelp();
		for (const flag of [
			"--help",
			"--version",
			"--print",
			"--mode",
			"--provider",
			"--model",
			"--continue",
			"--resume",
			"--session",
			"--no-session",
			"--tools",
			"--extension",
			"--offline",
		]) {
			expect(help).toContain(flag);
		}
	});

	test("every advertised long flag is actually accepted by parseArgs", () => {
		const flags = listCliHelpFlags();
		expect(flags.length).toBeGreaterThan(10);

		for (const name of flags) {
			const value = SAMPLE_VALUE[name] ?? "value";
			const result = parseArgs([`--${name}`, value]);

			expect(result.unknownFlags.has(name), `--${name} should be consumed`).toBe(false);
			const errors = result.diagnostics.filter((diagnostic) => diagnostic.type === "error");
			expect(errors, `--${name} should not produce an error`).toEqual([]);
		}
	});

	test("every help section has at least one option", () => {
		for (const section of CLI_HELP_SECTIONS) {
			expect(section.options.length).toBeGreaterThan(0);
		}
	});
});
