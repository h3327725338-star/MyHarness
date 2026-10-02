import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkRefusalStatus } from "../src/tools/web-search/engines/common.ts";
import { BROWSER_HEADERS } from "../src/tools/web-search/http.ts";
import type { TransportPage } from "../src/tools/web-search/transport.ts";

describe("web request profile", () => {
	it("uses navigation headers and only falls back on challenge-like search 503 responses", () => {
		expect(BROWSER_HEADERS["Sec-Fetch-Mode"]).toBe("navigate");
		expect(BROWSER_HEADERS["Accept-Encoding"]).toBe("gzip, deflate, br");
		const page = (text: string): TransportPage => ({
			status: 503,
			text,
			url: "https://example.com",
			headers: new Headers(),
			via: "http",
		});
		expect(() => checkRefusalStatus("Search", page("Verify you are human: challenge"))).toThrow(/503/u);
		expect(() => checkRefusalStatus("Search", page("Service unavailable"))).not.toThrow();
	});
	it.skipIf(process.platform !== "win32")(
		"compiles the native window helper and exits normally on release",
		async () => {
			const source = readFileSync(new URL("../src/tools/web-search/browser/foreground.ts", import.meta.url), "utf8");
			const script = /const script = `([\s\S]*?)`;/u
				.exec(source)![1]!
				.replaceAll("$" + "{pid}", String(process.pid));
			const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
				const child = spawn(
					"powershell.exe",
					["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
					{ windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
				);
				let stderr = "";
				child.stderr.on("data", (value) => {
					stderr += value;
				});
				child.on("error", reject);
				child.on("exit", (code) => resolve({ code, stderr }));
				child.stdin.end();
			});
			expect(result).toEqual({ code: 0, stderr: "" });
		},
		30_000,
	);
});
