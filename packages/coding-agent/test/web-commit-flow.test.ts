import { beforeEach, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	state: { items: [] as Array<{ result?: unknown }>, gitTask: null as unknown },
	post: vi.fn(),
	loadGitStatus: vi.fn(),
	toast: vi.fn(),
}));
vi.mock("../web/js/store.js", () => ({
	...store,
	activeSlotId: () => "slot",
	inSlot: (_slot: string, run: () => void) => run(),
	set: (patch: object) => Object.assign(store.state, patch),
	api: vi.fn(),
}));

const { commitChanges } = await import(new URL("../web/js/git-flow.js", import.meta.url).href);

beforeEach(() => {
	vi.clearAllMocks();
	store.state.items = [];
	store.state.gitTask = null;
	store.post.mockImplementation(async (route: string) =>
		route === "/api/git/record" ? { id: "saved" } : { status: "failed", failure: "hook failed\nlog" },
	);
});
it("keeps the error card without a user-log repair action and notifies after recovery stops", async () => {
	await commitChanges();
	expect(store.state.items).toHaveLength(1);
	expect(store.state.items[0]!.result).toMatchObject({ tone: "error", lines: "hook failed\nlog" });
	expect(store.state.items[0]!.result).not.toHaveProperty("fix");
	expect(store.post.mock.calls.map((call) => call[0])).toEqual(["/api/git/commit", "/api/git/record"]);
	expect(store.toast).toHaveBeenCalledWith(expect.stringContaining("no further retries"), "error", 9000);
	expect(store.loadGitStatus).toHaveBeenCalledTimes(1);
	expect(store.state.gitTask).toBeNull();
});
it.each(["committed", "no-changes"])("refreshes actual uncommitted status after %s", async (status) => {
	store.post.mockImplementation(async (route: string) =>
		route === "/api/git/record" ? { id: "saved" } : { status, message: "saved", commitHash: "abcdefg" },
	);
	await commitChanges();
	expect(store.loadGitStatus).toHaveBeenCalledTimes(1);
	expect(store.toast).not.toHaveBeenCalled();
});
