import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getMutationQueueKey,
	withFileMutationQueue,
	withFileMutationQueues,
} from "../src/tools/files/file-mutation-queue.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(process.env.TEMP ?? tmpdir(), "myharness-queue-multi-"));
	dirs.push(dir);
	return dir;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function probe(create: (dir: string) => void): boolean {
	const dir = mkdtempSync(join(process.env.TEMP ?? tmpdir(), "myharness-queue-probe-"));
	try {
		create(dir);
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const DIRECTORY_ALIAS = process.platform === "win32" ? "junction" : "dir";
const canAliasDirectories = probe((dir) => {
	mkdirSync(join(dir, "real"));
	symlinkSync(join(dir, "real"), join(dir, "alias"), DIRECTORY_ALIAS);
});
const canHardLink = probe((dir) => {
	writeFileSync(join(dir, "a"), "x");
	linkSync(join(dir, "a"), join(dir, "b"));
});

describe("withFileMutationQueues", () => {
	it("holds every file of a batch, so a single-file operation on any of them waits", async () => {
		const dir = tempDir();
		const order: string[] = [];

		const batch = withFileMutationQueues([join(dir, "a"), join(dir, "b")], async () => {
			order.push("batch:start");
			await delay(40);
			order.push("batch:end");
		});
		await delay(5);
		const single = withFileMutationQueue(join(dir, "b"), async () => {
			order.push("single");
		});
		const other = withFileMutationQueue(join(dir, "c"), async () => {
			order.push("other");
		});

		await Promise.all([batch, single, other]);

		expect(order.indexOf("other")).toBeLessThan(order.indexOf("batch:end"));
		expect(order.indexOf("single")).toBeGreaterThan(order.indexOf("batch:end"));
	});

	it("cannot deadlock batches that name the same files in opposite order", async () => {
		const dir = tempDir();
		const x = join(dir, "x");
		const y = join(dir, "y");
		const finished: string[] = [];

		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				withFileMutationQueues(index % 2 === 0 ? [x, y] : [y, x], async () => {
					await delay(1);
					finished.push(String(index));
				}),
			),
		);

		expect(finished).toHaveLength(20);
	});

	it("runs a batch with duplicate paths once and releases the queue when the batch fails", async () => {
		const dir = tempDir();
		const path = join(dir, "a");

		await expect(
			withFileMutationQueues([path, path, path.toUpperCase()], async () => {
				throw new Error("batch failed");
			}),
		).rejects.toThrow("batch failed");
		await expect(withFileMutationQueue(path, async () => "free")).resolves.toBe("free");
	});
});

describe("abandoning the wait for a queue", () => {
	it("rejects at once when the signal is already aborted, and never runs the work", async () => {
		const dir = tempDir();
		const controller = new AbortController();
		controller.abort();
		let ran = false;

		await expect(
			withFileMutationQueue(
				join(dir, "a"),
				async () => {
					ran = true;
				},
				{ signal: controller.signal },
			),
		).rejects.toMatchObject({ name: "AbortError" });

		expect(ran).toBe(false);
		await expect(withFileMutationQueue(join(dir, "a"), async () => "free")).resolves.toBe("free");
	});

	it("leaves the earlier operation running and still keeps later operations behind it", async () => {
		const dir = tempDir();
		const path = join(dir, "a");
		const order: string[] = [];

		const holder = withFileMutationQueue(path, async () => {
			order.push("holder:start");
			await delay(120);
			order.push("holder:end");
		});
		await delay(10);
		const controller = new AbortController();
		const abandoned = withFileMutationQueue(
			path,
			async () => {
				order.push("abandoned");
			},
			{ signal: controller.signal },
		);
		await delay(10);
		controller.abort();
		await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
		const later = withFileMutationQueue(path, async () => {
			order.push("later");
		});

		await Promise.all([holder, later]);

		expect(order).toEqual(["holder:start", "holder:end", "later"]);
	});

	it("does not interrupt work that has started", async () => {
		const dir = tempDir();
		const controller = new AbortController();

		const result = await withFileMutationQueue(
			join(dir, "a"),
			async () => {
				controller.abort();
				await delay(10);
				return "finished";
			},
			{ signal: controller.signal },
		);

		expect(result).toBe("finished");
	});
});

describe("getMutationQueueKey", () => {
	it.skipIf(process.platform !== "win32")(
		"ignores letter case on Windows, for files that do not exist yet too",
		async () => {
			const dir = tempDir();

			expect(await getMutationQueueKey(join(dir, "New", "File.ts"))).toBe(
				await getMutationQueueKey(join(dir.toUpperCase(), "new", "file.TS")),
			);
		},
	);

	it.skipIf(!canAliasDirectories)(
		"gives a file that does not exist yet the key it will have through a directory link",
		async () => {
			const dir = tempDir();
			mkdirSync(join(dir, "real"));
			symlinkSync(join(dir, "real"), join(dir, "alias"), DIRECTORY_ALIAS);

			expect(await getMutationQueueKey(join(dir, "alias", "fresh.ts"))).toBe(
				await getMutationQueueKey(join(dir, "real", "fresh.ts")),
			);
		},
	);

	it.skipIf(!canHardLink)("gives hard links of one file a single key", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "a"), "x");
		linkSync(join(dir, "a"), join(dir, "b"));

		expect(await getMutationQueueKey(join(dir, "a"))).toBe(await getMutationQueueKey(join(dir, "b")));
	});

	it("keeps different files apart", async () => {
		const dir = tempDir();

		expect(await getMutationQueueKey(join(dir, "a"))).not.toBe(await getMutationQueueKey(join(dir, "b")));
	});
});
