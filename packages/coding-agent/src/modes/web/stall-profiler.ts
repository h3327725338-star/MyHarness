import { Worker } from "node:worker_threads";

/**
 * Names the code behind an event-loop stall. A worker thread watches a beat the main thread gives on every StallWatch
 * check; once the beat is late it starts V8's sampling profiler on the main thread through the inspector (commands reach
 * a busy main thread between two JavaScript calls, not in the middle of one native call), stops it when the beat comes
 * back and sends the functions most samples were in. The stall line alone said only how long and which requests, so
 * periodic freezes with no request in progress could not be traced from a log.
 */

/** How late the beat must be before sampling starts; StallWatch reports from 300 ms, so every sampled stall is logged. */
const LATE_MS = 400;
const POLL_MS = 50;
/** Sampling interval in microseconds. */
const SAMPLE_US = 1000;
const MAX_LISTED = 3;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const inspector = require("node:inspector");
const beat = new Int32Array(workerData.beat);
const session = new inspector.Session();
session.connectToMainThread();
const post = (method, params) =>
	new Promise((resolve, reject) => session.post(method, params || {}, (error, result) => (error ? reject(error) : resolve(result))));
let ready = post("Profiler.enable").then(() => post("Profiler.setSamplingInterval", { interval: ${SAMPLE_US} }));
let last = Atomics.load(beat, 0);
let lastChange = Date.now();
let profiling = false;
const own = (url) => url.startsWith("file:") && !url.includes("/node_modules/");
const where = (frame) => {
	const path = decodeURIComponent(frame.url).replace(/\\\\/g, "/");
	const inSource = path.match(/\\/(?:src|dist)\\/(.+)$/);
	const short = inSource ? inSource[1] : path.split("/").pop();
	return (frame.functionName || "(anonymous)") + " (" + short + ":" + (frame.lineNumber + 1) + ")";
};
function summarize(profile) {
	const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
	const parent = new Map();
	for (const node of profile.nodes) for (const child of node.children || []) parent.set(child, node.id);
	// Samples grouped by the innermost two frames of MyHarness code; the native or library call under them is the hint.
	const groups = new Map();
	let total = 0;
	for (const id of profile.samples) {
		const leaf = nodes.get(id);
		if (!leaf || leaf.callFrame.functionName === "(idle)") continue;
		total += 1;
		const chain = [];
		for (let current = id; current !== undefined && chain.length < 2; current = parent.get(current)) {
			const frame = nodes.get(current).callFrame;
			if (own(frame.url) && !chain.some((item) => item.functionName === frame.functionName)) chain.push(frame);
		}
		const key = chain.length ? chain.map(where).join(" < ") : "";
		const group = groups.get(key) || { count: 0, leaves: new Map() };
		group.count += 1;
		if (chain[0] !== leaf.callFrame) {
			const name = leaf.callFrame.functionName || "(program)";
			group.leaves.set(name, (group.leaves.get(name) || 0) + 1);
		}
		groups.set(key, group);
	}
	if (total === 0) return undefined;
	return [...groups.entries()]
		.filter(([, group]) => group.count / total >= 0.02)
		.sort((a, b) => b[1].count - a[1].count)
		.slice(0, ${MAX_LISTED})
		.map(([key, group]) => {
			const leaf = [...group.leaves.entries()].sort((a, b) => b[1] - a[1])[0];
			const where = key ? key + (leaf ? " [" + leaf[0] + "]" : "") : leaf ? leaf[0] : "(program)";
			return Math.round((group.count / total) * 100) + "% " + where;
		})
		.join("; ");
}
setInterval(() => {
	const value = Atomics.load(beat, 0);
	const now = Date.now();
	if (value !== last) {
		last = value;
		lastChange = now;
		if (!profiling) return;
		profiling = false;
		post("Profiler.stop")
			.then(({ profile }) => {
				const summary = summarize(profile);
				if (summary) parentPort.postMessage(summary);
			})
			.catch(() => {});
		return;
	}
	if (profiling || now - lastChange < ${LATE_MS}) return;
	profiling = true;
	ready = ready.then(() => post("Profiler.start")).catch(() => {
		profiling = false;
	});
}, ${POLL_MS});
`;

export interface StallProfiler {
	/** The main thread is running: call at least every 100 ms. */
	beat(): void;
	stop(): void;
}

/**
 * Start the sampling worker; `onSummary` gets one line per stall it sampled, e.g.
 * `82% hashEntity (sync/engine.ts:874) < planUploads (sync/engine.ts:927) [readFileSync]; 10% …`.
 * Returns undefined where worker threads or the inspector are not available: the stall lines still appear without it.
 */
export function startStallProfiler(onSummary: (summary: string) => void): StallProfiler | undefined {
	let worker: Worker;
	const beat = new Int32Array(new SharedArrayBuffer(4));
	try {
		worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { beat: beat.buffer } });
	} catch {
		return undefined;
	}
	worker.unref();
	worker.on("message", (summary: unknown) => {
		if (typeof summary === "string") onSummary(summary);
	});
	// Diagnostics only: a worker that cannot attach (no inspector in this build) must never affect the server.
	worker.on("error", () => {});
	return {
		beat: () => {
			Atomics.add(beat, 0, 1);
		},
		stop: () => {
			void worker.terminate().catch(() => {});
		},
	};
}
