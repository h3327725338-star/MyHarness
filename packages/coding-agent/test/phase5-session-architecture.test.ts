import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrateSessionEntries } from "../src/session/migrations/index.ts";
import { loadEntriesFromFile, writeSessionFile } from "../src/session/storage/jsonl/index.ts";
import type { FileEntry } from "../src/session/types.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readSource(relativePath: string): string {
	return readFileSync(join(repositoryRoot, relativePath), "utf8").replaceAll("\\", "/");
}

describe("Phase 5 session boundaries", () => {
	it("keeps manager coordination separate from JSONL I/O and projection", () => {
		const manager = readSource("packages/coding-agent/src/session/manager/index.ts");
		const storage = readSource("packages/coding-agent/src/session/storage/jsonl/index.ts");
		const projection = readSource("packages/coding-agent/src/session/projection/index.ts");

		expect(manager).toContain("../storage/jsonl/index.ts");
		expect(manager).toContain("../projection/index.ts");
		expect(manager).toContain("../migrations/index.ts");
		expect(manager).not.toMatch(/from ["'](?:fs|fs\/promises|readline|string_decoder)["']/);
		expect(manager).not.toMatch(/(?:modes\/interactive|myharness-tui)/);
		expect(storage).toMatch(/from ["']fs["']/);
		expect(projection).toContain("sessionEntryToContextMessages");
		expect(projection).not.toMatch(/(?:modes\/interactive|myharness-tui)/);
	});

	it("keeps the v1 to v3 migration and JSONL round trip in focused modules", () => {
		const entries = [
			{ type: "session", id: "legacy", timestamp: "2024-01-01T00:00:00.000Z", cwd: "." },
			{ type: "message", message: { role: "user", content: "hello", timestamp: 1 } },
		] as unknown as FileEntry[];

		migrateSessionEntries(entries);
		expect(entries[0]).toMatchObject({ type: "session", version: 3 });
		expect(entries[1]).toMatchObject({ type: "message", parentId: null });
		expect(typeof entries[1].id).toBe("string");

		const sessionDir = mkdtempSync(join(tmpdir(), "myharness-phase5-session-"));
		const sessionFile = join(sessionDir, "round-trip.jsonl");
		writeSessionFile(sessionFile, entries);
		expect(loadEntriesFromFile(sessionFile)).toEqual(entries);
	});
});
