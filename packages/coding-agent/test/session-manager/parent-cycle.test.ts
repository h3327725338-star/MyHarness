import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectEntriesForBranchSummary } from "../../src/context/compact/branch-summarization.ts";
import { CURRENT_SESSION_VERSION, SessionManager, SessionParentCycleError } from "../../src/session/manager/index.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

/**
 * A corrupted session file can contain a parentId that points back into its own
 * ancestor chain. Following it used to loop forever; truncating it silently
 * would present an incomplete transcript as real history. Traversal must fail
 * with a clear error while leaving the session file untouched.
 */
describe("SessionManager parent chain cycle", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `myharness-parent-cycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSessionFile(name: string, entries: Array<Record<string, unknown>>): string {
		const filePath = join(tempDir, name);
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "cyclic-session",
			timestamp: new Date().toISOString(),
			cwd: tempDir,
		};
		const lines = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n");
		writeFileSync(filePath, `${lines}\n`);
		return filePath;
	}

	function messageEntry(id: string, parentId: string, text: string, role: "user" | "assistant") {
		return {
			type: "message",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			message: role === "user" ? userMsg(text) : assistantMsg(text),
		};
	}

	it("throws a clear cycle error for a two-entry cycle and leaves the file untouched", () => {
		const filePath = writeSessionFile("two-cycle.jsonl", [
			messageEntry("a", "b", "first user", "user"),
			messageEntry("b", "a", "second assistant", "assistant"),
		]);
		const before = readFileSync(filePath, "utf8");

		const session = SessionManager.open(filePath);
		let error: unknown;
		try {
			session.getBranch();
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(SessionParentCycleError);
		const cycleError = error as SessionParentCycleError;
		expect(cycleError.cycleIds).toEqual(["b", "a"]);
		expect(cycleError.message).toContain("cyclic");
		expect(cycleError.message).toContain("b -> a -> b");
		expect(cycleError.message).toContain(filePath);
		expect(cycleError.message).toContain("was not modified");
		// Source history is preserved: the file is byte-identical after the failure.
		expect(readFileSync(filePath, "utf8")).toBe(before);
	});

	it("throws the same error from buildSessionContext (the session-load context path)", () => {
		const filePath = writeSessionFile("context-cycle.jsonl", [
			messageEntry("a", "b", "first user", "user"),
			messageEntry("b", "a", "second assistant", "assistant"),
		]);

		const session = SessionManager.open(filePath);
		expect(() => session.buildSessionContext()).toThrow(SessionParentCycleError);
	});

	it("detects a self-parent entry", () => {
		const filePath = writeSessionFile("self-cycle.jsonl", [messageEntry("x", "x", "self parent", "user")]);

		const session = SessionManager.open(filePath);
		let error: unknown;
		try {
			session.getBranch();
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(SessionParentCycleError);
		expect((error as SessionParentCycleError).cycleIds).toEqual(["x"]);
	});

	it("keeps the full path for a well-formed session", () => {
		const filePath = writeSessionFile("valid.jsonl", [
			{ ...messageEntry("one", "", "hello", "user"), parentId: null },
			messageEntry("two", "one", "world", "assistant"),
			messageEntry("three", "two", "again", "user"),
		]);

		const session = SessionManager.open(filePath);
		expect(session.getBranch().map((entry) => entry.id)).toEqual(["one", "two", "three"]);
		expect(session.buildSessionContext().messages).toHaveLength(3);
	});

	it("returns no branch for an unknown explicit fromId", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("hello"));
		expect(session.getBranch("does-not-exist")).toEqual([]);
	});

	it("fails branch-entry collection instead of walking a cyclic chain", () => {
		const filePath = writeSessionFile("branch-cycle.jsonl", [
			messageEntry("a", "b", "first", "user"),
			messageEntry("b", "a", "second", "assistant"),
		]);

		const session = SessionManager.open(filePath);
		expect(() => collectEntriesForBranchSummary(session, "b", "a")).toThrow(SessionParentCycleError);
	});
});
