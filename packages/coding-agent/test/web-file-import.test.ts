import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";

it("stores arbitrary file bytes inside the originating session without overwriting", async () => {
	const root = mkdtempSync(join(tmpdir(), "myharness-import-"));
	const server = new WebHttpServer();
	const host = {
		inputTouched: false,
		session: {
			sessionManager: { getCwd: () => root, getSessionFile: () => join(root, "conversation", "session.jsonl") },
		},
	};
	try {
		registerFileRoutes(server, host as unknown as WebHost);
		const { port } = await server.listen(0);
		const upload = async (body: unknown) => {
			const response = await fetch(`http://127.0.0.1:${port}/api/files/upload`, {
				method: "POST",
				headers: { "x-myharness-web": "1", "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			return { status: response.status, data: (await response.json()) as { name: string; path: string } };
		};
		const bytes = Buffer.from([0, 255, 12, 42]);
		const first = await upload({ name: "../../CON.bin", data: bytes.toString("base64") });
		const second = await upload({ name: "../../CON.bin", data: "" });
		expect(first.status).toBe(200);
		expect(first.data.name).toBe("CON.bin");
		expect(relative(root, first.data.path)).not.toMatch(/^\.\./);
		expect(readFileSync(first.data.path)).toEqual(bytes);
		expect(first.data.path).not.toBe(second.data.path);
		expect(host.inputTouched).toBe(true);
		expect((await upload({ name: "bad", data: "%%%=" })).status).toBe(400);
		expect((await upload({ name: 1, data: "" })).status).toBe(400);
	} finally {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
