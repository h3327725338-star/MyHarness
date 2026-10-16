// Locks for the attachments.js same-frame batching: hooks mounting in the same microtask frame
// share one POST /api/uploads/info-batch (through the store api() channel), cache hits make no
// request, and invalidation forces a refetch. Failure entries (with their status) are cached too.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	apiCalls: [] as Array<{ path: string; options: unknown }>,
	hookStates: [] as Array<{ value: unknown }>,
	apiImpl: null as null | ((path: string, options?: unknown) => Promise<unknown>),
}));

vi.mock("../web/js/ui.js", () => ({
	html: (...args: unknown[]) => ({ type: "vnode", args }),
	Icon: () => null,
	Spinner: () => null,
	Collapse: () => null,
	useState: (init: unknown) => {
		const record = { value: init };
		mocks.hookStates.push(record);
		return [
			record.value,
			(next: unknown) => {
				record.value = next;
			},
		];
	},
	useEffect: (fn: () => unknown) => {
		fn();
	},
}));

vi.mock("../web/js/store.js", () => ({
	activeSlotId: () => "",
	api: (path: string, options: unknown) => mocks.apiImpl!(path, options),
}));

const webDir = new URL("../web/js/", import.meta.url);
const attachments = await import(new URL("attachments.js", webDir).href);

const tick = async (rounds = 5) => {
	for (let index = 0; index < rounds; index += 1) await Promise.resolve();
};

function fakeBatchApi(
	handler: (paths: string[]) => Array<{ path: string; ok: boolean; meta?: unknown; status?: number; error?: string }>,
) {
	mocks.apiImpl = async (path: string, options: unknown) => {
		mocks.apiCalls.push({ path, options });
		if (path !== "/api/uploads/info-batch") throw new Error(`unexpected request: ${path}`);
		const body = (options as { body?: { paths?: string[] } }).body;
		return { results: handler(body?.paths ?? []) };
	};
}

const okMeta = (path: string) => ({
	path,
	ok: true,
	meta: { name: path, path, exists: true, size: 3 },
});

beforeEach(() => {
	mocks.apiCalls.length = 0;
	mocks.hookStates.length = 0;
	attachments.invalidateAttachmentCaches();
});

describe("useAttachmentMeta batching", () => {
	it("sends one POST for hooks mounted in the same frame", async () => {
		fakeBatchApi((paths) => paths.map(okMeta));
		attachments.useAttachmentMeta("a");
		attachments.useAttachmentMeta("b");
		attachments.useAttachmentMeta("c");
		await tick();
		expect(mocks.apiCalls).toHaveLength(1);
		expect(mocks.apiCalls[0]!.path).toBe("/api/uploads/info-batch");
		expect((mocks.apiCalls[0]!.options as { body: { paths: string[] } }).body).toEqual({ paths: ["a", "b", "c"] });
		// Every hook got its own entry back.
		expect(mocks.hookStates.map((record) => (record.value as { data?: { path: string } }).data?.path).sort()).toEqual(
			["a", "b", "c"],
		);
	});

	it("serves a repeated render from the cache with zero requests", async () => {
		fakeBatchApi((paths) => paths.map(okMeta));
		attachments.useAttachmentMeta("a");
		await tick();
		expect(mocks.apiCalls).toHaveLength(1);
		mocks.apiCalls.length = 0;
		mocks.hookStates.length = 0;
		const state = attachments.useAttachmentMeta("a");
		await tick();
		expect(mocks.apiCalls).toHaveLength(0);
		expect((state as { data?: { path: string } }).data?.path).toBe("a");
	});

	it("refetches after invalidation", async () => {
		fakeBatchApi((paths) => paths.map(okMeta));
		attachments.useAttachmentMeta("a");
		await tick();
		expect(mocks.apiCalls).toHaveLength(1);
		attachments.invalidateAttachmentCaches("a");
		attachments.useAttachmentMeta("a");
		await tick();
		expect(mocks.apiCalls).toHaveLength(2);
	});

	it("falls back to single GETs when an older server has no batch route", async () => {
		mocks.apiImpl = async (path: string) => {
			mocks.apiCalls.push({ path, options: undefined });
			if (path === "/api/uploads/info-batch") {
				const error = new Error("Not found");
				(error as Error & { status?: number }).status = 404;
				throw error;
			}
			const uploadPath = new URL(path, "http://localhost").searchParams.get("path") ?? "";
			return { name: uploadPath, path: uploadPath, exists: true };
		};
		attachments.useAttachmentMeta("a");
		attachments.useAttachmentMeta("b");
		await tick();
		expect(mocks.apiCalls[0]!.path).toBe("/api/uploads/info-batch");
		expect(
			mocks.apiCalls
				.slice(1)
				.map((call) => call.path)
				.sort(),
		).toEqual(["/api/uploads/info?path=a", "/api/uploads/info?path=b"]);
		expect(mocks.hookStates.map((record) => (record.value as { data?: { path: string } }).data?.path).sort()).toEqual(
			["a", "b"],
		);
	});

	it("does not fall back on batch errors that are not an old-server 404", async () => {
		mocks.apiImpl = async (path: string) => {
			mocks.apiCalls.push({ path, options: undefined });
			if (path === "/api/uploads/info-batch") {
				const error = new Error("Server error");
				(error as Error & { status?: number }).status = 500;
				throw error;
			}
			throw new Error("single GET must not be reached");
		};
		attachments.useAttachmentMeta("a");
		attachments.useAttachmentMeta("b");
		await tick();
		expect(mocks.apiCalls).toHaveLength(1);
		expect(mocks.apiCalls[0]!.path).toBe("/api/uploads/info-batch");
		expect(mocks.hookStates.map((record) => (record.value as { error?: unknown }).error).filter(Boolean).length).toBe(2);
	});

	it("caches 404 failures with their status and does not retry them", async () => {
		fakeBatchApi((paths) =>
			paths.map((path) => ({ path, ok: false, status: 404, error: "Attachment has been deleted." })),
		);
		attachments.useAttachmentMeta("gone");
		await tick();
		expect(mocks.apiCalls).toHaveLength(1);
		const first = mocks.hookStates[0]!.value as { error?: { status?: number } };
		expect(first.error?.status).toBe(404);
		mocks.apiCalls.length = 0;
		mocks.hookStates.length = 0;
		attachments.useAttachmentMeta("gone");
		await tick();
		expect(mocks.apiCalls).toHaveLength(0);
		const second = mocks.hookStates[0]!.value as { error?: { status?: number } };
		expect(second.error?.status).toBe(404);
	});
});
