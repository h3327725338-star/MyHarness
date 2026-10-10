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
import { DEFAULT_MAX_BYTES } from "../src/tools/truncate.ts";

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

describe("file read state tracking", () => {
	let testDir: string;
	let readTool: ReturnType<typeof createReadTool>;
	let writeTool: ReturnType<typeof createWriteTool>;
	let editTool: ReturnType<typeof createEditTool>;

	beforeEach(async () => {
		clearFileReadStates();
		testDir = await mkdtemp(join(tmpdir(), "myharness-read-state-test-"));
		readTool = createReadTool(testDir);
		writeTool = createWriteTool(testDir);
		editTool = createEditTool(testDir);
	});

	afterEach(async () => {
		clearFileReadStates();
		await rm(testDir, { recursive: true, force: true });
	});

	describe("unread file mutation rejection", () => {
		it("rejects edit on an existing unread file with FILE_NOT_READ", async () => {
			const target = join(testDir, "unread-edit.txt");
			await writeFile(target, "initial content\n", "utf8");

			let caughtError: any;
			try {
				await editTool.execute("call-1", {
					path: target,
					edits: [{ oldText: "initial", newText: "modified" }],
				});
			} catch (error) {
				caughtError = error;
			}

			expect(caughtError).toBeDefined();
			expect(caughtError.code).toBe("FILE_NOT_READ");
			expect(caughtError.details).toMatchObject({ code: "FILE_NOT_READ" });
			expect(caughtError.message).toContain("the file was not read in this Session");
			expect(caughtError.message).toContain("Read it with the read tool first, then repeat the edit.");
		});

		it("rejects write overwrite on an existing unread file with FILE_NOT_READ", async () => {
			const target = join(testDir, "unread-overwrite.txt");
			await writeFile(target, "existing content\n", "utf8");

			let caughtError: any;
			try {
				await writeTool.execute("call-2", {
					path: target,
					content: "new content\n",
				});
			} catch (error) {
				caughtError = error;
			}

			expect(caughtError).toBeDefined();
			expect(caughtError.code).toBe("FILE_NOT_READ");
			expect(caughtError.details).toMatchObject({ code: "FILE_NOT_READ" });
			expect(caughtError.message).toContain("the file already exists but was not read in this Session");
			expect(caughtError.message).toContain("Read it with the read tool first, then repeat the write.");
		});

		it("allows write creating a new non-existent file without reading", async () => {
			const target = join(testDir, "brand-new.txt");

			const result = await writeTool.execute("call-3", {
				path: target,
				content: "brand new content\n",
			});

			expect(getTextOutput(result)).toContain("Successfully wrote");
			expect(await readFile(target, "utf8")).toBe("brand new content\n");
		});
	});

	describe("successful mutations after reading & consecutive mutations", () => {
		it("allows edit after reading the file", async () => {
			const target = join(testDir, "read-then-edit.txt");
			await writeFile(target, "line 1\nline 2\n", "utf8");

			await readTool.execute("read-1", { path: target });
			const result = await editTool.execute("edit-1", {
				path: target,
				edits: [{ oldText: "line 2\n", newText: "line two\n" }],
			});

			expect(getTextOutput(result)).toContain("Successfully replaced 1 block(s)");
			expect(await readFile(target, "utf8")).toBe("line 1\nline two\n");
		});

		it("allows consecutive edits after a single initial read without re-reading", async () => {
			const target = join(testDir, "consecutive-edits.txt");
			await writeFile(target, "alpha\nbeta\ngamma\n", "utf8");

			await readTool.execute("read-1", { path: target });

			const first = await editTool.execute("edit-1", {
				path: target,
				edits: [{ oldText: "alpha\n", newText: "ALPHA\n" }],
			});
			expect(getTextOutput(first)).toContain("Successfully replaced 1 block(s)");

			const second = await editTool.execute("edit-2", {
				path: target,
				edits: [{ oldText: "beta\n", newText: "BETA\n" }],
			});
			expect(getTextOutput(second)).toContain("Successfully replaced 1 block(s)");
			expect(await readFile(target, "utf8")).toBe("ALPHA\nBETA\ngamma\n");
		});

		it("allows consecutive writes after a single initial read without re-reading", async () => {
			const target = join(testDir, "consecutive-writes.txt");
			await writeFile(target, "original\n", "utf8");

			await readTool.execute("read-1", { path: target });

			await writeTool.execute("write-1", { path: target, content: "first update\n" });
			await writeTool.execute("write-2", { path: target, content: "second update\n" });

			expect(await readFile(target, "utf8")).toBe("second update\n");
		});

		it("allows edit immediately after write creation without calling read", async () => {
			const target = join(testDir, "write-then-edit.txt");

			await writeTool.execute("write-1", { path: target, content: "initial data\n" });
			const result = await editTool.execute("edit-1", {
				path: target,
				edits: [{ oldText: "initial data\n", newText: "updated data\n" }],
			});

			expect(getTextOutput(result)).toContain("Successfully replaced 1 block(s)");
			expect(await readFile(target, "utf8")).toBe("updated data\n");
		});
	});

	describe("stale file detection and recovery", () => {
		it("rejects edit when file is modified externally after reading with FILE_STALE", async () => {
			const target = join(testDir, "stale-edit.txt");
			await writeFile(target, "v1\n", "utf8");

			await readTool.execute("read-1", { path: target });

			// External modification
			await writeFile(target, "v2 external\n", "utf8");
			const future = new Date(Date.now() + 5000);
			await utimes(target, future, future);

			let caughtError: any;
			try {
				await editTool.execute("edit-stale", {
					path: target,
					edits: [{ oldText: "v1\n", newText: "v3\n" }],
				});
			} catch (error) {
				caughtError = error;
			}

			expect(caughtError).toBeDefined();
			expect(caughtError.code).toBe("FILE_STALE");
			expect(caughtError.details).toMatchObject({ code: "FILE_STALE" });
			expect(caughtError.message).toContain("the file changed on disk since it was last read");
			expect(caughtError.message).toContain("Read it again with the read tool, then repeat the edit.");
		});

		it("rejects write overwrite when file is modified externally after reading with FILE_STALE", async () => {
			const target = join(testDir, "stale-write.txt");
			await writeFile(target, "v1\n", "utf8");

			await readTool.execute("read-1", { path: target });

			// External modification
			await writeFile(target, "v2 external\n", "utf8");
			const future = new Date(Date.now() + 5000);
			await utimes(target, future, future);

			let caughtError: any;
			try {
				await writeTool.execute("write-stale", {
					path: target,
					content: "v3 overwrite\n",
				});
			} catch (error) {
				caughtError = error;
			}

			expect(caughtError).toBeDefined();
			expect(caughtError.code).toBe("FILE_STALE");
			expect(caughtError.details).toMatchObject({ code: "FILE_STALE" });
			expect(caughtError.message).toContain("the file changed on disk since it was last read");
			expect(caughtError.message).toContain("Read it again with the read tool, then repeat the write.");
		});

		it("rejects edit when file content changes with identical byte length after reading with FILE_STALE", async () => {
			const target = join(testDir, "stale-same-size-edit.txt");
			const initialContent = "hello world\n";
			const modifiedContent = "hello there\n";
			expect(Buffer.byteLength(initialContent, "utf8")).toBe(Buffer.byteLength(modifiedContent, "utf8"));
			await writeFile(target, initialContent, "utf8");

			await readTool.execute("read-1", { path: target });

			// External modification with identical byte length
			await writeFile(target, modifiedContent, "utf8");
			const future = new Date(Date.now() + 5000);
			await utimes(target, future, future);

			let caughtError: any;
			try {
				await editTool.execute("edit-same-size", {
					path: target,
					edits: [{ oldText: "world\n", newText: "earth\n" }],
				});
			} catch (error) {
				caughtError = error;
			}

			expect(caughtError).toBeDefined();
			expect(caughtError.code).toBe("FILE_STALE");
			expect(caughtError.details).toMatchObject({ code: "FILE_STALE" });
			expect(caughtError.message).toContain("the file changed on disk since it was last read");
			expect(caughtError.message).toContain("Read it again with the read tool, then repeat the edit.");
		});

		it("rejects write overwrite when file content changes with identical byte length after reading with FILE_STALE", async () => {
			const target = join(testDir, "stale-same-size-write.txt");
			const initialContent = "hello world\n";
			const modifiedContent = "hello there\n";
			expect(Buffer.byteLength(initialContent, "utf8")).toBe(Buffer.byteLength(modifiedContent, "utf8"));
			await writeFile(target, initialContent, "utf8");

			await readTool.execute("read-1", { path: target });

			// External modification with identical byte length
			await writeFile(target, modifiedContent, "utf8");
			const future = new Date(Date.now() + 5000);
			await utimes(target, future, future);

			let caughtError: any;
			try {
				await writeTool.execute("write-same-size", {
					path: target,
					content: "overwritten\n",
				});
			} catch (error) {
				caughtError = error;
			}

			expect(caughtError).toBeDefined();
			expect(caughtError.code).toBe("FILE_STALE");
			expect(caughtError.details).toMatchObject({ code: "FILE_STALE" });
			expect(caughtError.message).toContain("the file changed on disk since it was last read");
			expect(caughtError.message).toContain("Read it again with the read tool, then repeat the write.");
		});

		it("rejects edit when only mtime changes after reading with FILE_STALE", async () => {
			const target = join(testDir, "stale-mtime-only-edit.txt");
			const content = "hello world\n";
			await writeFile(target, content, "utf8");

			await readTool.execute("read-1", { path: target });

			// Only update mtime without modifying content or size
			const future = new Date(Date.now() + 5000);
			await utimes(target, future, future);

			let caughtError: any;
			try {
				await editTool.execute("edit-mtime-only", {
					path: target,
					edits: [{ oldText: "world\n", newText: "earth\n" }],
				});
			} catch (error) {
				caughtError = error;
			}

			expect(caughtError).toBeDefined();
			expect(caughtError.code).toBe("FILE_STALE");
			expect(caughtError.details).toMatchObject({ code: "FILE_STALE" });
			expect(caughtError.message).toContain("the file changed on disk since it was last read");
			expect(caughtError.message).toContain("Read it again with the read tool, then repeat the edit.");
		});

		it("allows editing after re-reading a stale file", async () => {
			const target = join(testDir, "recover-stale.txt");
			await writeFile(target, "v1\n", "utf8");

			await readTool.execute("read-1", { path: target });

			// External modification
			await writeFile(target, "v2 external\n", "utf8");
			const future = new Date(Date.now() + 5000);
			await utimes(target, future, future);

			// Rejected initially
			await expect(
				editTool.execute("edit-fail", {
					path: target,
					edits: [{ oldText: "v2 external\n", newText: "v3\n" }],
				}),
			).rejects.toThrow(/FILE_STALE|the file changed on disk/);

			// Re-read file
			await readTool.execute("read-2", { path: target });

			// Edit succeeds now
			const result = await editTool.execute("edit-success", {
				path: target,
				edits: [{ oldText: "v2 external\n", newText: "v3 recovered\n" }],
			});
			expect(getTextOutput(result)).toContain("Successfully replaced 1 block(s)");
			expect(await readFile(target, "utf8")).toBe("v3 recovered\n");
		});
	});

	describe("session isolation", () => {
		const session1Ctx = { sessionManager: { getSessionId: () => "session-1" } };
		const session2Ctx = { sessionManager: { getSessionId: () => "session-2" } };

		it("isolates read state between different sessions", async () => {
			const target = join(testDir, "session-isolated.txt");
			await writeFile(target, "hello world\n", "utf8");

			const readDef = createReadToolDefinition(testDir);
			const editDef = createEditToolDefinition(testDir);

			// Read in session 1 only
			await readDef.execute("read-s1", { path: target }, undefined, undefined, session1Ctx);

			// Session 2 has not read it: edit is refused
			await expect(
				editDef.execute(
					"edit-s2",
					{ path: target, edits: [{ oldText: "world", newText: "sess2" }] },
					undefined,
					undefined,
					session2Ctx,
				),
			).rejects.toThrow(/FILE_NOT_READ|not read in this Session/);

			// Session 1 has read it: edit succeeds
			const s1Result = await editDef.execute(
				"edit-s1",
				{ path: target, edits: [{ oldText: "world", newText: "sess1" }] },
				undefined,
				undefined,
				session1Ctx,
			);
			expect(getTextOutput(s1Result)).toContain("Successfully replaced 1 block(s)");
		});

		it("detects external mutation across sessions", async () => {
			const target = join(testDir, "cross-session-stale.txt");
			await writeFile(target, "base content\n", "utf8");

			const readDef = createReadToolDefinition(testDir);
			const editDef = createEditToolDefinition(testDir);

			// Both sessions read base content
			await readDef.execute("read-s1", { path: target }, undefined, undefined, session1Ctx);
			await readDef.execute("read-s2", { path: target }, undefined, undefined, session2Ctx);

			// Session 1 mutates the file
			await editDef.execute(
				"edit-s1",
				{ path: target, edits: [{ oldText: "base", newText: "modified-by-s1" }] },
				undefined,
				undefined,
				session1Ctx,
			);

			// Session 1 can edit again without re-reading
			await editDef.execute(
				"edit-s1-again",
				{ path: target, edits: [{ oldText: "content", newText: "text" }] },
				undefined,
				undefined,
				session1Ctx,
			);

			// Session 2's recorded state is now stale compared to disk
			await expect(
				editDef.execute(
					"edit-s2",
					{ path: target, edits: [{ oldText: "modified-by-s1", newText: "s2" }] },
					undefined,
					undefined,
					session2Ctx,
				),
			).rejects.toThrow(/FILE_STALE|the file changed on disk/);
		});
	});

	describe("table capacity and LRU eviction", () => {
		it("evicts oldest entries when MAX_TRACKED_FILE_STATES is exceeded without throwing", () => {
			const scope = "capacity-test";
			expect(fileReadStateCount()).toBe(0);

			for (let i = 0; i < MAX_TRACKED_FILE_STATES; i++) {
				recordFileReadState(join(testDir, `file-${i}.txt`), { mtimeMs: i, size: i }, scope);
			}

			expect(fileReadStateCount()).toBe(MAX_TRACKED_FILE_STATES);
			expect(getFileReadState(join(testDir, "file-0.txt"), scope)).toBeDefined();

			// Accessing file-0 marks it as recently used
			// Now insert entry 1000: file-1 (now the oldest untouched) should be evicted
			recordFileReadState(
				join(testDir, `file-${MAX_TRACKED_FILE_STATES}.txt`),
				{ mtimeMs: 9999, size: 9999 },
				scope,
			);

			expect(fileReadStateCount()).toBe(MAX_TRACKED_FILE_STATES);
			expect(getFileReadState(join(testDir, "file-0.txt"), scope)).toBeDefined();
			expect(getFileReadState(join(testDir, "file-1.txt"), scope)).toBeUndefined();
			expect(getFileReadState(join(testDir, `file-${MAX_TRACKED_FILE_STATES}.txt`), scope)).toBeDefined();
		});
	});

	describe("file mutation queue serialization", () => {
		it("serializes concurrent write creation followed by edit on the same path", async () => {
			const target = join(testDir, "concurrent-create-edit.txt");

			const writePromise = writeTool.execute("write-call", {
				path: target,
				content: "first write line\n",
			});

			const editPromise = editTool.execute("edit-call", {
				path: target,
				edits: [{ oldText: "first write line\n", newText: "edited line\n" }],
			});

			const [writeRes, editRes] = await Promise.all([writePromise, editPromise]);

			expect(getTextOutput(writeRes)).toContain("Successfully wrote");
			expect(getTextOutput(editRes)).toContain("Successfully replaced 1 block(s)");
			expect(await readFile(target, "utf8")).toBe("edited line\n");
		});
	});

	describe("read tool line counting and formatting", () => {
		it("reports 0 total lines for an empty file", async () => {
			const target = join(testDir, "empty-file.txt");
			await writeFile(target, "", "utf8");

			const result = await readTool.execute("read-empty", { path: target });
			expect(getTextOutput(result)).toBe("");

			await expect(readTool.execute("read-empty-offset", { path: target, offset: 2 })).rejects.toThrow(
				/Offset 2 is beyond end of file \(0 lines total\)/,
			);
		});

		it("does not count a trailing newline as an extra line", async () => {
			const target = join(testDir, "trailing-newline.txt");
			await writeFile(target, "line 1\nline 2\n", "utf8");

			const result = await readTool.execute("read-two-lines", { path: target });
			expect(getTextOutput(result)).toBe("line 1\nline 2\n");

			await expect(readTool.execute("read-beyond", { path: target, offset: 3 })).rejects.toThrow(
				/Offset 3 is beyond end of file \(2 lines total\)/,
			);
		});

		it("quotes file path in long first line notice", async () => {
			const target = join(testDir, "super-long-line.txt");
			const longLine = "a".repeat(DEFAULT_MAX_BYTES + 2048);
			await writeFile(target, `${longLine}\nsecond line\n`, "utf8");

			const result = await readTool.execute("read-long", { path: target });
			const output = getTextOutput(result);

			expect(output).toContain(`sed -n '1p' "${target}" | head -c`);
		});
	});

	describe("write tool UTF-8 byte counting", () => {
		it("reports exact UTF-8 byte count for multibyte Chinese characters", async () => {
			const target = join(testDir, "chinese-bytes.txt");
			const content = "你好，世界"; // 5 characters, 15 UTF-8 bytes
			const expectedBytes = Buffer.byteLength(content, "utf8");
			expect(expectedBytes).toBe(15);

			const result = await writeTool.execute("write-cn", { path: target, content });
			const output = getTextOutput(result);

			expect(output).toContain(`Successfully wrote 15 bytes to ${target}`);
		});
	});

	describe("custom operations (non-local filesystem)", () => {
		it("bypasses read state validation when custom operations are provided", async () => {
			let customReadFileCalled = false;
			let customWriteFileCalled = false;
			const target = join(testDir, "custom-ops.txt");

			const customEditTool = createEditToolDefinition(testDir, {
				operations: {
					access: async () => {},
					readFile: async () => {
						customReadFileCalled = true;
						return Buffer.from("remote content\n", "utf8");
					},
					writeFile: async () => {
						customWriteFileCalled = true;
					},
				},
			});

			// No read call was made before this edit, yet it does not fail with FILE_NOT_READ
			const result = await customEditTool.execute(
				"custom-edit",
				{
					path: target,
					edits: [{ oldText: "remote content\n", newText: "remote modified\n" }],
				},
				undefined,
				undefined,
				undefined,
			);

			expect(customReadFileCalled).toBe(true);
			expect(customWriteFileCalled).toBe(true);
			expect(getTextOutput(result)).toContain("Successfully replaced 1 block(s)");
		});
	});
});
