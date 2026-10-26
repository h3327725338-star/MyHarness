/**
 * Hub 防御：新建 30s 宽限、opening 避让、closeSlot 前 touchedAt 复查。
 * 全部用 stub host，不起真实 runtime。
 */

import { describe, expect, it } from "vitest";
import type { WebHost } from "../src/modes/web/host.ts";
import { WebHttpServer } from "../src/modes/web/http-server.ts";
import { SLOT_STARTUP_GRACE_MS, WebHostHub } from "../src/modes/web/hub.ts";

interface StubSpec {
	touchedAt: number;
	startedAt?: number;
	busy?: boolean;
}

function stubHost(slotId: string, spec: StubSpec, disposed: string[]): WebHost {
	return {
		slotId,
		startedAt: spec.startedAt ?? 0,
		touchedAt: spec.touchedAt,
		session: { isIdle: !spec.busy, sessionManager: { getEntryCount: () => 0 } },
		completionActive: false,
		dialogs: { requests: [] },
		gitTask: null,
		backgroundGit: new Set(),
		unread: false,
		status: { slot: slotId },
		transcriptCacheBytes: 0,
		tracker: { listRuns: () => [] },
		dispose: async () => {
			disposed.push(slotId);
		},
	} as unknown as WebHost;
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

interface HubInternals {
	slots: Map<string, WebHost>;
	primary: WebHost | undefined;
	opening: Map<string, Promise<WebHost>>;
}

function setupHub(
	disposed: string[],
	options: ConstructorParameters<typeof WebHostHub>[0] & { server: WebHttpServer },
): { hub: WebHostHub; internals: HubInternals; keep: WebHost } {
	const hub = new WebHostHub(options);
	const internals = hub as unknown as HubInternals;
	const primary = stubHost("s-primary", { touchedAt: 0 }, disposed);
	internals.slots.set(primary.slotId, primary);
	internals.primary = primary;
	const keep = stubHost("s-keep", { touchedAt: 100 }, disposed);
	internals.slots.set(keep.slotId, keep);
	return { hub, internals, keep };
}

describe("WebHostHub.pruneIdle defenses", () => {
	it("treats slots created within the grace period as busy", async () => {
		expect(SLOT_STARTUP_GRACE_MS).toBe(30_000);
		const disposed: string[] = [];
		const server = new WebHttpServer();
		const bytes = new Map([
			["s-young", 10],
			["s-old", 10],
			["s-older", 10],
		]);
		const { hub, internals, keep } = setupHub(disposed, {
			server,
			version: "test",
			onShutdown: () => {},
			idleBudgetBytes: 15, // room for one of the two aged idle slots
			maxIdleSlots: 100,
			estimateSlotBytes: (host) => bytes.get(host.slotId) ?? 0,
		});
		// Youngest by touch but freshly created: grace must protect it.
		internals.slots.set("s-young", stubHost("s-young", { touchedAt: 1, startedAt: Date.now() }, disposed));
		internals.slots.set("s-old", stubHost("s-old", { touchedAt: 2, startedAt: 0 }, disposed));
		internals.slots.set("s-older", stubHost("s-older", { touchedAt: 3, startedAt: 0 }, disposed));

		(hub as unknown as { pruneIdle: (keep: WebHost) => void }).pruneIdle(keep);
		await tick();

		expect(disposed).toEqual(["s-old"]);
		expect(internals.slots.has("s-young")).toBe(true);
		await server.close();
	});

	it("defers pruning while an open/create is still in flight", async () => {
		const disposed: string[] = [];
		const server = new WebHttpServer();
		const { hub, internals, keep } = setupHub(disposed, {
			server,
			version: "test",
			onShutdown: () => {},
			maxIdleSlots: 1, // two idle slots would otherwise evict the oldest
		});
		internals.slots.set("s-a", stubHost("s-a", { touchedAt: 1 }, disposed));
		internals.slots.set("s-b", stubHost("s-b", { touchedAt: 2 }, disposed));
		internals.opening.set("some-session", Promise.resolve({} as WebHost));

		(hub as unknown as { pruneIdle: (keep: WebHost) => void }).pruneIdle(keep);
		await tick();
		expect(disposed).toEqual([]);

		internals.opening.clear();
		(hub as unknown as { pruneIdle: (keep: WebHost) => void }).pruneIdle(keep);
		await tick();
		expect(disposed).toEqual(["s-a"]);
		await server.close();
	});

	it("skips an eviction candidate touched within the recheck window", async () => {
		const disposed: string[] = [];
		const server = new WebHttpServer();
		const bytes = new Map([
			["s-new", 10],
			["s-old", 10],
		]);
		const { hub, internals, keep } = setupHub(disposed, {
			server,
			version: "test",
			onShutdown: () => {},
			idleBudgetBytes: 15, // only one of the two fits
			maxIdleSlots: 100,
			estimateSlotBytes: (host) => bytes.get(host.slotId) ?? 0,
		});
		internals.slots.set("s-new", stubHost("s-new", { touchedAt: Date.now() }, disposed));
		// Second-newest, but still addressed a second ago: the budget plan evicts it,
		// the touchedAt recheck must save it this round.
		internals.slots.set("s-old", stubHost("s-old", { touchedAt: Date.now() - 1000 }, disposed));

		(hub as unknown as { pruneIdle: (keep: WebHost) => void }).pruneIdle(keep);
		await tick();

		expect(disposed).toEqual([]);
		expect(internals.slots.has("s-old")).toBe(true);
		expect(internals.slots.has("s-new")).toBe(true);
		await server.close();
	});
});
