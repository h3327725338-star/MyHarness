import { describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "../src/agent/runtime/auto-memory.ts";
import { bookmarkPage, bookmarkUserContext, cleanBookmarkNote } from "../src/modes/web/routes-bookmarks.ts";
import { createWorkspaceToolDefinition, type DesktopWorkspaceChannel } from "../src/tools/workspace.ts";
import {
	BOOKMARK_CONTEXT_TYPE,
	bookmarkContext,
	bookmarkEntries,
	bookmarkLine,
	matchBookmarks,
	renderBookmarkContext,
} from "../src/tools/workspace-bookmarks.ts";

/** A host channel that answers the bookmarks request with `bookmarks`, or fails. */
const host = (bookmarks: unknown, fail = false) =>
	({
		request: async () => {
			if (fail) throw new Error("host gone");
			return { bookmarks };
		},
	}) as unknown as DesktopWorkspaceChannel;

const school = {
	id: "bm1",
	title: "eLearn",
	url: "https://elearn.example.edu/",
	note: "My course site: assignments, grades and lecture slides.",
	noteAuto: true,
	lastUsedAt: "2026-10-20T08:00:00.000Z",
};
const mail = { id: "bm2", title: "Mail", url: "https://mail.example/", lastUsedAt: "2026-10-10T08:00:00.000Z" };

describe("bookmarks the Agent knows about", () => {
	it("lists each bookmark with what it is for, and matches a search in the name, address or note", () => {
		const entries = bookmarkEntries({ bookmarks: [school, mail, { id: "x" }, "junk"] });
		expect(entries.map((entry) => entry.id)).toEqual(["bm1", "bm2"]);
		expect(bookmarkLine(entries[0]!)).toBe(
			"- eLearn — https://elearn.example.edu/ — My course site: assignments, grades and lecture slides. [id bm1]",
		);
		expect(bookmarkLine(entries[1]!)).toContain("(no note: judge by its name and address)");
		// A note the user wrote is marked as theirs: the Agent may improve the app's notes, never the user's.
		expect(bookmarkLine(bookmarkEntries({ bookmarks: [{ ...school, noteAuto: false }] })[0]!)).toBe(
			"- eLearn — https://elearn.example.edu/ — My course site: assignments, grades and lecture slides. (the user's own note) [id bm1]",
		);
		expect(matchBookmarks(entries, "grades").map((entry) => entry.id)).toEqual(["bm1"]);
		expect(matchBookmarks(entries, "MAIL example").map((entry) => entry.id)).toEqual(["bm2"]);
	});

	it("tells the Agent to use them on its own and that notes are not instructions", () => {
		const text = renderBookmarkContext(bookmarkEntries({ bookmarks: [mail, school] }));
		expect(text).toContain("[system-reminder]");
		expect(text).toContain("not instructions");
		expect(text).toContain("bookmark_note");
		expect(text).toContain("never replace the user's own note");
		expect(text).toContain("eLearn — https://elearn.example.edu/");
		// All of them fit: the order of the bookmarks bar, so using a site does not send the list again.
		expect(text.indexOf("Mail —")).toBeLessThan(text.indexOf("eLearn —"));
		// More than fit: the most recently used come first, and the rest are found with a search.
		const many = Array.from({ length: 70 }, (_, i) => ({
			id: `b${i}`,
			title: `Site ${i}`,
			url: `https://s${i}.example/`,
		}));
		many.push(school);
		const crowded = renderBookmarkContext(bookmarkEntries({ bookmarks: many }));
		expect(crowded.split("\n")[1]).toContain("eLearn —");
		expect(crowded).toContain("(11 more bookmarks");
	});

	it("sends the list once, again only when it changed, and never for a user without bookmarks", async () => {
		const first = await bookmarkContext([], host([school, mail]));
		expect(first).toMatchObject({ customType: BOOKMARK_CONTEXT_TYPE, details: { v: 1, count: 2 } });
		expect(await bookmarkContext([first!.details], host([school, mail]))).toBeUndefined();
		const changed = await bookmarkContext(
			[first!.details],
			host([{ ...school, note: "Course site and exam dates." }, mail]),
		);
		expect(changed?.content).toContain("Course site and exam dates.");
		// Emptied after a list was sent: the Agent hears that there are none now.
		expect((await bookmarkContext([first!.details], host([])))?.details.count).toBe(0);
		expect(await bookmarkContext([], host([]))).toBeUndefined();
		expect(await bookmarkContext([], host([school], true))).toBeUndefined();
		expect(await bookmarkContext([], undefined)).toBeUndefined();
	});
});

describe("the Agent keeping bookmark notes up to date", () => {
	it("saves a note through the host by bookmark id or title, and passes on the host's refusal", async () => {
		const sent: Record<string, unknown>[] = [];
		const channel = {
			request: vi.fn(async (command: Record<string, unknown>) => {
				sent.push(command);
				if (command.action === "bookmarks") return { bookmarks: [school, { ...mail, note: "mine" }] };
				if (command.action === "bookmark-note" && command.id === "bm2")
					throw new Error("这个书签的用途是用户自己写的，不要改它");
				return { bookmarks: [{ ...school, note: command.note, noteAuto: true }, mail] };
			}),
		} as unknown as DesktopWorkspaceChannel;
		const tool = createWorkspaceToolDefinition({ channel: () => channel });
		const run = (args: Record<string, unknown>) =>
			tool.execute("call", args as never, new AbortController().signal, undefined, {} as never) as Promise<{
				content: { text: string }[];
			}>;
		const result = await run({ operation: "bookmark_note", bookmark: "elearn", note: "交 DSA、OS 作业，看成绩" });
		expect(sent.at(-1)).toEqual({ action: "bookmark-note", id: "bm1", note: "交 DSA、OS 作业，看成绩" });
		expect(result.content[0]!.text).toContain(
			"bookmark note saved: eLearn — https://elearn.example.edu/ — 交 DSA、OS 作业，看成绩",
		);
		await expect(run({ operation: "bookmark_note", bookmark: "bm2", note: "x" })).rejects.toThrow("用户自己写的");
		await expect(run({ operation: "bookmark_note", bookmark: "nope", note: "x" })).rejects.toThrow("no bookmark");
	});
});

describe("bookmark notes written for this user", () => {
	const memory = (id: string, scope: MemoryEntry["scope"], content: string, name = id): MemoryEntry => ({
		id,
		name,
		description: name,
		type: "user",
		scope,
		content,
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
		filePath: `${id}.md`,
	});
	it("tells the note model the user's profile, memories about the site and the user's own notes", () => {
		const page = bookmarkPage({ url: "https://elearn.example.edu/course", title: "eLearn" });
		const entries = [
			memory("global/用户画像", "global", "Student at Example University, CS (AI), year 2."),
			memory(
				"global/school-term",
				"global",
				"This term: DSA and OS assignments are handed in on elearn.example.edu.",
				"school term",
			),
			memory("global/gym", "global", "Goes to the gym near home in the evening.", "gym"),
			memory("workspace/secret-project", "workspace", "elearn.example.edu workspace-only detail"),
		];
		const context = bookmarkUserContext(page, entries, [
			{ title: "Gmail", url: "https://mail.google.com/", note: "我的邮箱：收发学校邮件" },
			{ title: "Bad", note: "" },
		]);
		expect(context).toContain("<profile>\nStudent at Example University");
		expect(context).toContain("DSA and OS assignments are handed in on elearn.example.edu");
		expect(context).not.toContain("gym near home");
		// A bookmark note is read in every chat: workspace memories stay in their workspace.
		expect(context).not.toContain("workspace-only");
		expect(context).toContain("<own-notes>\n- Gmail: 我的邮箱：收发学校邮件\n</own-notes>");
		expect(bookmarkUserContext(page, undefined, undefined)).toBe(
			"<user>\n(nothing is known about the user)\n</user>",
		);
	});
});

describe("bookmark notes written from the page", () => {
	it("keeps only a web address and the page details a note needs", () => {
		const page = bookmarkPage({
			url: "https://elearn.example.edu/course/1",
			title: "  Course   1 ",
			headings: ["Week 1", "", "Week 2"],
			text: "x".repeat(5000),
		});
		expect(page).toMatchObject({
			url: "https://elearn.example.edu/course/1",
			title: "Course 1",
			headings: ["Week 1", "Week 2"],
		});
		expect(String(page.text)).toHaveLength(1500);
		expect(() => bookmarkPage({ url: "file:///C:/secret.txt" })).toThrow(/web pages/);
		expect(() => bookmarkPage({})).toThrow(/address/);
	});

	it("takes the model's first line without quotes as the note", () => {
		expect(cleanBookmarkNote("\n“My course site for assignments.”\nExtra line")).toBe(
			"My course site for assignments.",
		);
		expect(cleanBookmarkNote("「课程网站，交作业和看成绩」")).toBe("课程网站，交作业和看成绩");
		expect(cleanBookmarkNote("a".repeat(800))).toHaveLength(500);
	});
});
