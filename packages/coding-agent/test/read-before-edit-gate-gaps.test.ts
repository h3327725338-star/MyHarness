import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool, createEditToolDefinition } from "../src/tools/files/edit.ts";
import { createReadTool, createReadToolDefinition } from "../src/tools/files/read.ts";
import {
	clearFileReadStates,
	fileReadStateCount,
	getFileReadState,
	MAX_TRACKED_FILE_STATES,
	recordFileReadState,
} from "../src/tools/files/read-state.ts";
import { createWriteTool } from "../src/tools/files/write.ts";

/**
 * Gap coverage for the read-before-edit gate (N04-T2a, gaps A1-A8 in
 * `data/overnight-2026-10-10/tests-2a/gaps.md`). The happy paths, the mtime/size staleness
 * matrix and the Session isolation cases already live in `read-state.test.ts`; this file only
 * adds the refusals' *side effects* (nothing written, nothing recorded), the path-key
 * normalisation, the scope fallback, the abort branch, the eviction consequence and the
 * deleted-file branch.
 */

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

async function captureError(promise: Promise<unknown>): Promise<any> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to be refused, but it succeeded");
}

describe("read-before-edit gate gaps", () => {
	let testDir: string;
	let readTool: ReturnType<typeof createReadTool>;
	let writeTool: ReturnType<typeof createWriteTool>;
	let editTool: ReturnType<typeof createEditTool>;

	beforeEach(async () => {
		clearFileReadStates();
		testDir = await mkdtemp(join(tmpdir(), "myharness-read-gate-gaps-"));
		readTool = createReadTool(testDir);
		writeTool = createWriteTool(testDir);
		editTool = createEditTool(testDir);
	});

	afterEach(async () => {
		clearFileReadStates();
		await rm(testDir, { recursive: true, force: true });
	});

	it("refuses an unread edit without touching the file bytes", async () => {
		const target = join(testDir, "refused-edit.txt");
		await writeFile(target, "external content v1\n", "utf8");

		const error = await captureError(
			editTool.execute("call-a1", { path: target, edits: [{ oldText: "v1", newText: "v2" }] }),
		);

		expect(error.code).toBe("FILE_NOT_READ");
		// The refusal is actionable and points at the resolved file, not a relative guess.
		expect(error.details).toMatchObject({ code: "FILE_NOT_READ", path: target });
		expect(error.message).toContain("the file was not read in this Session");
		// Nothing was written and nothing was tracked by the refused call.
		expect(await readFile(target, "utf8")).toBe("external content v1\n");
		expect(fileReadStateCount()).toBe(0);
	});

	it("refuses a stale write without discarding the external content", async () => {
		const target = join(testDir, "refused-write.txt");
		await writeFile(target, "model saw this\n", "utf8");
		await readTool.execute("read-a2", { path: target });

		// External change: same length, different bytes, later mtime.
		await writeFile(target, "someone else\n", "utf8");
		const future = new Date(Date.now() + 5000);
		await utimes(target, future, future);

		const error = await captureError(writeTool.execute("write-a2", { path: target, content: "mine\n" }));

		expect(error.code).toBe("FILE_STALE");
		expect(error.message).toContain("the file changed on disk since it was last read");
		// The whole point of the gate: the newer external bytes survive the refused overwrite.
		expect(await readFile(target, "utf8")).toBe("someone else\n");
		// And the refused call did not refresh the stale record into a fresh one.
		expect(getFileReadState(target)?.size).toBe(Buffer.byteLength("model saw this\n", "utf8"));
	});

	it("allows a whole-file edit after only a partial read with offset and limit", async () => {
		const target = join(testDir, "partial-read.txt");
		await writeFile(target, "alpha\nbeta\ngamma\n", "utf8");

		// Only the tail of the file was shown to the model. T01's receipt records this as an
		// intentional file-level simplification; the assertion locks that decision so a future
		// change to line-level tracking is a deliberate edit, not a silent regression.
		const read = await readTool.execute("read-a3", { path: target, offset: 3, limit: 1 });
		expect(getTextOutput(read)).toContain("gamma");

		const result = await editTool.execute("edit-a3", {
			path: target,
			edits: [{ oldText: "alpha\n", newText: "ALPHA\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced 1 block(s)");
		expect(await readFile(target, "utf8")).toBe("ALPHA\nbeta\ngamma\n");
	});

	it("shares one read-state entry between a relative read and an absolute edit of the same file", async () => {
		const target = join(testDir, "path-key.txt");
		await writeFile(target, "hello world\n", "utf8");

		// `read` resolves the relative name to an absolute path internally; `edit` is handed the
		// absolute path. Both must land on the same canonical key or every relative read would
		// leave the file permanently "unread".
		await readTool.execute("read-a4", { path: "path-key.txt" });
		expect(getFileReadState(target)).toBeDefined();

		const result = await editTool.execute("edit-a4", {
			path: target,
			edits: [{ oldText: "world\n", newText: "there\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced 1 block(s)");
		expect(await readFile(target, "utf8")).toBe("hello there\n");
	});

	it("falls back to the shared read-state scope when the extension context getter throws", async () => {
		const target = join(testDir, "broken-ctx.txt");
		await writeFile(target, "original\n", "utf8");
		const replacedRunnerCtx = {
			get sessionManager(): never {
				throw new Error("extension runner was replaced");
			},
		};

		const readDefinition = createReadToolDefinition(testDir);
		const editDefinition = createEditToolDefinition(testDir);

		// A failing Session lookup must not fail an otherwise valid read; it downgrades to the
		// shared scope, which is the same scope a context-less call resolves to.
		await readDefinition.execute("read-a5", { path: target }, undefined, undefined, replacedRunnerCtx);

		const result = await editDefinition.execute(
			"edit-a5",
			{ path: target, edits: [{ oldText: "original\n", newText: "edited\n" }] },
			undefined,
			undefined,
			undefined,
		);

		expect(getTextOutput(result)).toContain("Successfully replaced 1 block(s)");
		expect(await readFile(target, "utf8")).toBe("edited\n");
	});

	it("refuses an already-aborted edit without recording any read state", async () => {
		const target = join(testDir, "aborted-edit.txt");
		await writeFile(target, "v1\n", "utf8");
		await readTool.execute("read-a6", { path: target });

		// External change after the read, so the recorded state is stale.
		await writeFile(target, "v2 external\n", "utf8");
		const future = new Date(Date.now() + 5000);
		await utimes(target, future, future);

		const controller = new AbortController();
		controller.abort();
		const error = await captureError(
			editTool.execute(
				"edit-a6",
				{ path: target, edits: [{ oldText: "v2 external\n", newText: "v3\n" }] },
				controller.signal,
			),
		);

		expect(error.message).toContain("Operation aborted");
		expect(await readFile(target, "utf8")).toBe("v2 external\n");
		// The cancelled call must not leave a refreshed state behind: the next real edit still
		// sees the stale record and refuses.
		const followUp = await captureError(
			editTool.execute("edit-a6-followup", {
				path: target,
				edits: [{ oldText: "v2 external\n", newText: "v3\n" }],
			}),
		);
		expect(followUp.code).toBe("FILE_STALE");
	});

	it("refuses the edit of a file evicted from a full read-state table and recovers after re-reading", async () => {
		const target = join(testDir, "evicted.txt");
		await writeFile(target, "content\n", "utf8");
		await readTool.execute("read-a7", { path: target });
		expect(getFileReadState(target)).toBeDefined();

		// Fill the table with LRU-older dummy entries: the recorded read is now the oldest entry
		// and gets evicted, so the model's knowledge of this file is forgotten by the table.
		for (let index = 0; index < MAX_TRACKED_FILE_STATES; index++) {
			recordFileReadState(join(testDir, `filler-${index}.txt`), { mtimeMs: index, size: index });
		}
		expect(fileReadStateCount()).toBe(MAX_TRACKED_FILE_STATES);
		expect(getFileReadState(target)).toBeUndefined();

		const error = await captureError(
			editTool.execute("edit-a7", { path: target, edits: [{ oldText: "content\n", newText: "changed\n" }] }),
		);
		expect(error.code).toBe("FILE_NOT_READ");
		expect(await readFile(target, "utf8")).toBe("content\n");

		// Recovery is the model's documented next step: read again, then the edit goes through.
		await readTool.execute("read-a7-again", { path: target });
		const result = await editTool.execute("edit-a7-after-read", {
			path: target,
			edits: [{ oldText: "content\n", newText: "changed\n" }],
		});
		expect(getTextOutput(result)).toContain("Successfully replaced 1 block(s)");
		expect(await readFile(target, "utf8")).toBe("changed\n");
	});

	it("allows a write that recreates a file deleted after it was read", async () => {
		const target = join(testDir, "deleted-then-written.txt");
		await writeFile(target, "gone soon\n", "utf8");
		await readTool.execute("read-a8", { path: target });
		await rm(target);

		// A target that does not exist is a creation, so the gate cannot refuse it: nothing is
		// being discarded. `statFileReadState` reports "not an existing regular file" and the
		// check returns before comparing the recorded (now dangling) shape.
		const result = await writeTool.execute("write-a8", { path: target, content: "recreated\n" });

		expect(getTextOutput(result)).toContain("Successfully wrote");
		expect(await readFile(target, "utf8")).toBe("recreated\n");
		expect(getFileReadState(target)).toBeDefined();
	});
});
