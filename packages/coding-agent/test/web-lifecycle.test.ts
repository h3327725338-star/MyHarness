import { describe, expect, it } from "vitest";
import { WebLifecycle } from "../src/modes/web/lifecycle.ts";

function harness(graceSeconds = 10) {
	let grace = graceSeconds;
	let now = 0;
	let pending: { at: number; run: () => void } | undefined;
	let expired = 0;
	const lifecycle = new WebLifecycle({
		getGraceSeconds: () => grace,
		onExpire: () => {
			expired++;
		},
		setTimer: (run, delay) => {
			pending = { at: now + delay, run };
			return pending;
		},
		clearTimer: (handle) => {
			if (pending === handle) pending = undefined;
		},
	});
	return {
		lifecycle,
		setGrace: (value: number) => {
			grace = value;
		},
		advance(ms: number) {
			now += ms;
			if (pending && pending.at <= now) {
				const { run } = pending;
				pending = undefined;
				run();
			}
		},
		get expired() {
			return expired;
		},
		get waiting() {
			return pending !== undefined;
		},
	};
}

describe("Web UI lifecycle", () => {
	it("waits the grace period after the last page disconnects, then expires once", () => {
		const h = harness(10);
		h.lifecycle.clientCountChanged(1);
		h.lifecycle.clientCountChanged(0);
		h.advance(9_999);
		expect(h.expired).toBe(0);
		h.advance(1);
		expect(h.expired).toBe(1);
		h.lifecycle.clientCountChanged(0);
		h.advance(60_000);
		expect(h.expired).toBe(1);
	});

	it("keeps running while any page is connected and cancels the countdown when a page reconnects", () => {
		const h = harness(10);
		h.lifecycle.clientCountChanged(2);
		h.lifecycle.clientCountChanged(1);
		expect(h.waiting).toBe(false);
		h.lifecycle.clientCountChanged(0);
		h.advance(5_000);
		h.lifecycle.clientCountChanged(1); // reload
		expect(h.waiting).toBe(false);
		h.advance(60_000);
		expect(h.expired).toBe(0);
	});

	it("does not count down before any page has ever connected, but does after attaching late", () => {
		const h = harness(10);
		h.lifecycle.attach(0, false);
		expect(h.waiting).toBe(false);
		h.lifecycle.attach(0, true); // a page came and went before the lifecycle was wired
		expect(h.waiting).toBe(true);
	});

	it("reads the grace period again for every countdown", () => {
		const h = harness(10);
		h.lifecycle.clientCountChanged(1);
		h.setGrace(3);
		h.lifecycle.clientCountChanged(0);
		h.advance(3_000);
		expect(h.expired).toBe(1);
	});

	it("stops counting after dispose", () => {
		const h = harness(10);
		h.lifecycle.clientCountChanged(1);
		h.lifecycle.clientCountChanged(0);
		h.lifecycle.dispose();
		h.advance(60_000);
		expect(h.expired).toBe(0);
	});
});
