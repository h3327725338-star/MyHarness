/**
 * Notices when the server's event loop is blocked (a long synchronous read, parse or scan) and writes one line to the
 * server log: how long it was blocked and which API requests were in progress at the time. Earlier freezes (the
 * Session index re-read, a parser loop, a 137 MB chat file) were only found after the page sat at "加载中"; with this
 * the next one shows up in the log with a lead to follow. With `profile` on (the real service), a second line names the
 * functions the stall was spent in (see stall-profiler.ts).
 */

import { type StallProfiler, startStallProfiler } from "./stall-profiler.ts";

const CHECK_INTERVAL_MS = 100;
const STALL_THRESHOLD_MS = 300;
/** Longer gaps are the computer sleeping, not the server working. */
const SUSPEND_GAP_MS = 5 * 60 * 1000;
const MAX_LISTED_REQUESTS = 4;

export class StallWatch {
	private readonly inFlight = new Map<number, { label: string; startedAt: number }>();
	private nextId = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastTick = 0;
	private readonly report: (line: string) => void;
	private readonly thresholdMs: number;
	private readonly now: () => number;
	private readonly profile: boolean;
	private profiler: StallProfiler | undefined;

	constructor(
		report: (line: string) => void = (line) => console.error(line),
		thresholdMs = STALL_THRESHOLD_MS,
		now: () => number = () => performance.now(),
		options: { profile?: boolean } = {},
	) {
		this.report = report;
		this.thresholdMs = thresholdMs;
		this.now = now;
		this.profile = options.profile === true;
	}

	start(): void {
		if (this.timer) return;
		this.lastTick = this.now();
		this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
		this.timer.unref();
		if (this.profile)
			this.profiler = startStallProfiler((summary) => this.report(`Event loop was busy in: ${summary}`));
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.inFlight.clear();
		this.profiler?.stop();
		this.profiler = undefined;
	}

	/** Mark an API request as in progress; call the returned function when it has been answered. */
	track(label: string): () => void {
		const id = ++this.nextId;
		this.inFlight.set(id, { label, startedAt: this.now() });
		return () => {
			this.inFlight.delete(id);
		};
	}

	/** One check; the interval calls it, tests call it directly. */
	check(): void {
		this.profiler?.beat();
		const now = this.now();
		const blocked = now - this.lastTick - CHECK_INTERVAL_MS;
		this.lastTick = now;
		if (blocked < this.thresholdMs || blocked > SUSPEND_GAP_MS) return;
		const requests = [...this.inFlight.values()]
			.sort((a, b) => a.startedAt - b.startedAt)
			.slice(0, MAX_LISTED_REQUESTS)
			.map((request) => request.label);
		const more = this.inFlight.size - requests.length;
		const context =
			requests.length > 0
				? `; requests in progress: ${requests.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`
				: "; no API request in progress";
		this.report(`Event loop blocked for ${Math.round(blocked)} ms${context}`);
	}
}
