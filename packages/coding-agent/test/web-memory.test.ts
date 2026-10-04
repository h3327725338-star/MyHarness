import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";
import {
	archiveMemoryFile,
	getMemoryPaths,
	listMemoryFiles,
	type MemoryFile,
	writeMemoryFile,
} from "../src/session/memory/store.ts";

it("browses hierarchy scopes and restores archives through the real HTTP routes", async () => {
	const root = mkdtempSync(join(process.env.MYHARNESS_TEMP_DIR ?? tmpdir(), "web-memory-"));
	vi.stubEnv("MYHARNESS_CODING_AGENT_DIR", join(root, "agent"));
	const server = new WebHttpServer();
	const host = {
		completionActive: false,
		session: {
			isIdle: true,
			sessionManager: {
				getCwd: () => root,
				getDataRoot: () => root,
				getWorkspaceId: () => "a",
				getSessionId: () => "one",
			},
		},
	};
	try {
		const p = getMemoryPaths({ dataRoot: root, workspaceId: "a", sessionId: "one" });
		const raw = "---\nid: session/note\nname: note\nscope: session\n---\n\nold content\n";
		const file = join(p.sessionDir, "note.md");
		await writeMemoryFile(file, raw);
		await archiveMemoryFile(file, "updated");
		await writeMemoryFile(file, raw.replace("old content", "new content"));
		const other = getMemoryPaths({ dataRoot: root, workspaceId: "b", sessionId: "two" });
		await writeMemoryFile(join(other.sessionDir, "other.md"), raw);
		registerFileRoutes(server, host as unknown as WebHost);
		const { port } = await server.listen(0);
		const base = `http://127.0.0.1:${port}`;
		const current = (await (await fetch(`${base}/api/memory?scope=session`)).json()) as { entries: MemoryFile[] };
		expect(current.entries).toHaveLength(2);
		const all = (await (await fetch(`${base}/api/memory?scope=global`)).json()) as { entries: MemoryFile[] };
		expect(all.entries).toHaveLength(3);
		expect((await fetch(`${base}/api/memory?scope=invalid`)).status).toBe(400);
		const archive = listMemoryFiles(root).find((entry) => entry.archived)!;
		const restore = () =>
			fetch(`${base}/api/memory/restore`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-myharness-web": "1" },
				body: JSON.stringify({ path: archive.path }),
			});
		host.completionActive = true;
		expect((await restore()).status).toBe(409);
		host.completionActive = false;
		expect((await restore()).status).toBe(200);
		expect(readFileSync(file, "utf8")).toContain("old content");
		expect(listMemoryFiles(root).filter((entry) => entry.archived)).toHaveLength(2);
	} finally {
		await server.close();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});
