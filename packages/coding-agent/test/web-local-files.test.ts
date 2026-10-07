import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { buildLocalFileScript, resolveLocalFile, runLocalFileAction } from "../src/modes/web/local-files.ts";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";

const { localLinkPath, pathCandidates } = await import(new URL("../web/js/local-file-links.js", import.meta.url).href);
describe("local desktop file links", () => {
	it("classifies local links without enabling executable URL schemes", () => {
		for (const link of ["C:/Docs/My file.pptx", "file:///C:/Docs/My%20file.pptx", "../docs/report.md"])
			expect(localLinkPath(link)).toBe(link);
		for (const link of [
			"https://example.com",
			"javascript:alert(1)",
			"data:text/html,hi",
			"sandbox:/mnt/data/report.pptx",
			"//server/file",
			"#heading",
		])
			expect(localLinkPath(link)).toBeNull();
		expect(localLinkPath("/api/artifacts/download?path=a.txt")).toBe("/api/artifacts/download?path=a.txt");
	});
	it("finds Unicode paths and excludes web addresses", () => {
		expect(
			pathCandidates("打开 ShopEase_Q2.pptx，或者 docs/报告.md。 C:\\Docs\\a.txt").map(
				(p: { path: string }) => p.path,
			),
		).toEqual(["ShopEase_Q2.pptx", "docs/报告.md", "C:\\Docs\\a.txt"]);
		expect(pathCandidates("https://example.com/a.txt javascript:alert(1)")).toEqual([]);
	});
	it("resolves existing paths and rejects nonlocal or missing targets", async () => {
		const root = process.cwd();
		expect(await resolveLocalFile(root, "package.json")).toEqual({
			path: join(root, "package.json"),
			directory: false,
		});
		expect(await resolveLocalFile(root, ".")).toEqual({ path: root, directory: true });
		for (const value of ["https://example.com", "shell:AppsFolder", "\\\\server\\file", "bad\u0000.txt", ""])
			await expect(resolveLocalFile(root, value)).rejects.toThrow();
		await expect(resolveLocalFile(root, "missing-local-file-12345.txt")).rejects.toThrow("does not exist");
	});
	it("resolves local paths through the existing same-origin HTTP boundary", async () => {
		const server = new WebHttpServer();
		registerFileRoutes(server, {
			session: { sessionManager: { getCwd: () => process.cwd() } },
		} as unknown as WebHost);
		const address = await server.listen(0);
		const endpoint = `http://127.0.0.1:${address.port}/api/files/local`;
		try {
			const request = (body: unknown) =>
				fetch(endpoint, {
					method: "POST",
					headers: { "content-type": "application/json", "x-myharness-web": "1" },
					body: JSON.stringify(body),
				});
			const resolved = await request({ path: "package.json", action: "resolve" });
			expect(resolved.status).toBe(200);
			expect(await resolved.json()).toEqual({ path: join(process.cwd(), "package.json"), directory: false });
			expect((await request({ path: "package.json", action: "execute" })).status).toBe(400);
			expect((await request({ path: "shell:AppsFolder", action: "open" })).status).toBe(400);
			expect((await fetch(endpoint, { method: "POST", headers: { origin: "https://example.com" } })).status).toBe(
				403,
			);
		} finally {
			await server.close();
		}
	});
	it("encodes paths as data instead of PowerShell syntax", () => {
		const file = "C:\\Docs\\'; Start-Process calc; '.txt";
		expect(buildLocalFileScript(file, "open")).not.toContain(file);
		expect(buildLocalFileScript(file, "open")).toContain(Buffer.from(file).toString("base64"));
	});
	it.skipIf(process.platform !== "win32")(
		"discovers Windows handlers and refuses an unknown handler without opening apps",
		async () => {
			const file = join(process.cwd(), "package.json");
			const choices = await runLocalFileAction(file, "choices");
			expect(Array.isArray(choices)).toBe(true);
			for (const choice of choices as { id: string; label: string }[]) {
				expect(choice.id).toBeTruthy();
				expect(choice.label).toBeTruthy();
			}
			await expect(runLocalFileAction(file, "handler", "not-an-installed-handler")).rejects.toThrow(
				"no longer available",
			);
		},
		60000,
	);
});
