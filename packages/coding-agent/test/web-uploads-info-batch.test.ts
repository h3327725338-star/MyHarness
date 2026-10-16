// Locks for POST /api/uploads/info-batch: one batched metadata POST instead of one GET per
// attachment. Whole-request shape errors answer 400; per-path failures stay per-path inside a 200
// answer; the endpoint is read-only (statSync) and never writes manifests or deletes files.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { registerFileRoutes } from "../src/modes/web/routes-files.ts";

const HEADERS = { "content-type": "application/json", "x-myharness-web": "1" };

let root = "";
let server: WebHttpServer | null = null;
let base = "";
let fileA = "";
let fileB = "";

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "myharness-uploads-batch-"));
	const dirA = join(root, "uploads", "id-a");
	const dirB = join(root, "uploads", "id-b");
	mkdirSync(dirA, { recursive: true });
	mkdirSync(dirB, { recursive: true });
	fileA = join(dirA, "attachment-a.txt");
	fileB = join(dirB, "attachment-b.txt");
	writeFileSync(fileA, "hello-a");
	writeFileSync(fileB, "hello-b-longer");
	server = new WebHttpServer();
	const host = {
		session: {
			sessionManager: {
				getCwd: () => root,
				getDataRoot: () => root,
			},
		},
	};
	registerFileRoutes(server, host as unknown as WebHost);
	const { port } = await server.listen(0);
	base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
	if (server) await server.close();
	server = null;
	rmSync(root, { recursive: true, force: true });
});

function postBatch(body: unknown) {
	return fetch(`${base}/api/uploads/info-batch`, {
		method: "POST",
		headers: HEADERS,
		body: JSON.stringify(body),
	});
}

type BatchItem =
	| { path: string; ok: true; meta: { name: string; path: string; exists: boolean; size?: number } }
	| { path: string; ok: false; status: number; error: string };

async function postPaths(paths: unknown) {
	const res = await postBatch({ paths });
	return { status: res.status, json: (await res.json()) as { results: BatchItem[] } };
}

describe("POST /api/uploads/info-batch", () => {
	it("answers one path with its metadata", async () => {
		const { status, json } = await postPaths([fileA]);
		expect(status).toBe(200);
		expect(json.results).toHaveLength(1);
		const [item] = json.results;
		expect(item?.ok).toBe(true);
		if (item?.ok) {
			expect(item.meta.exists).toBe(true);
			expect(item.meta.name).toBe("a.txt");
			expect(item.meta.size).toBe(7);
		}
	});

	it("answers N paths in first-seen order", async () => {
		const { status, json } = await postPaths([fileA, fileB]);
		expect(status).toBe(200);
		expect(json.results.map((item) => item.path)).toEqual([fileA, fileB]);
		expect(json.results.every((item) => item.ok)).toBe(true);
	});

	it("dedupes repeated paths keeping the first occurrence", async () => {
		const { status, json } = await postPaths([fileB, fileA, fileB, fileA]);
		expect(status).toBe(200);
		expect(json.results.map((item) => item.path)).toEqual([fileB, fileA]);
	});

	it("rejects an empty array with 400", async () => {
		expect((await postBatch({ paths: [] })).status).toBe(400);
	});

	it("rejects more than 100 paths with 400", async () => {
		const paths = Array.from({ length: 101 }, (_, index) => `${fileA}#${index}`);
		expect((await postPaths(paths)).status).toBe(400);
	});

	it("rejects a single path longer than 4096 characters with 400", async () => {
		expect((await postPaths([`x`.repeat(4097)])).status).toBe(400);
	});

	it("keeps an illegal path per-path: 200 overall, ok:false with status 400", async () => {
		const { status, json } = await postPaths(["not-an-attachment.txt"]);
		expect(status).toBe(200);
		expect(json.results).toHaveLength(1);
		const [item] = json.results;
		expect(item?.ok).toBe(false);
		if (item && !item.ok) expect(item.status).toBe(400);
	});

	it("mixes existing and deleted files: ok:true next to ok:false with status 404", async () => {
		const missing = join(root, "uploads", "id-gone", "attachment-gone.txt");
		const { status, json } = await postPaths([fileA, missing]);
		expect(status).toBe(200);
		expect(json.results).toHaveLength(2);
		expect(json.results[0]?.ok).toBe(true);
		const [second] = json.results.slice(1);
		expect(second?.ok).toBe(false);
		if (second && !second.ok) expect(second.status).toBe(404);
	});

	it("is read-only: no manifests are written and no files disappear", async () => {
		const before = readdirSync(join(root, "uploads")).sort();
		const { status } = await postPaths([fileA, fileB]);
		expect(status).toBe(200);
		expect(readdirSync(join(root, "uploads")).sort()).toEqual(before);
	});
});
