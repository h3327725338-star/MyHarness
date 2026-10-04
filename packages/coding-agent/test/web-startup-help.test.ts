import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/startup/args.ts";
import { listWebStartupHelpFlags, renderWebStartupHelp, WEB_STARTUP_HELP_SECTIONS } from "../src/startup/help.ts";

/** Valid sample value for flags whose value is validated further. */
const SAMPLE_VALUE: Record<string, string> = {
	mode: "json",
	thinking: "high",
	"agent-role": "main",
	"context-window": "256K",
	port: "0",
};

describe("Web startup help", () => {
	test("renders a usage line with the app name", () => {
		const help = renderWebStartupHelp();
		expect(help).toMatch(/^Usage: \S+ \[options\]/);
	});

	test("advertises the general, model and session flags", () => {
		const help = renderWebStartupHelp();
		for (const flag of [
			"--help",
			"--version",
			"--no-open",
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

	test("does not advertise removed terminal output modes", () => {
		const flags = listWebStartupHelpFlags();
		for (const flag of ["print", "mode", "list-models"]) expect(flags).not.toContain(flag);
	});

	test("every advertised long flag is actually accepted by parseArgs", () => {
		const flags = listWebStartupHelpFlags();
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
		for (const section of WEB_STARTUP_HELP_SECTIONS) {
			expect(section.options.length).toBeGreaterThan(0);
		}
	});
});
