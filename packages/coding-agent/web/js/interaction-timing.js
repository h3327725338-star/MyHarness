// Bounded local measurements. No telemetry, timers, or retained conversation content.
const samples = [];
const now = () => globalThis.performance?.now?.() ?? Date.now();
export function startInteraction(kind) {
	const sample = { kind, startedAt: now(), visibleMs: null, contentMs: null, paintMs: null };
	samples.push(sample);
	if (samples.length > 40) samples.shift();
	return sample;
}
export function measureInteraction(sample, phase) {
	if (!sample || sample[phase] !== null) return;
	sample[phase] = now() - sample.startedAt;
	if (phase === "visibleMs" && typeof requestAnimationFrame === "function") {
		// An opportunity to paint, not a claim that the browser presented a frame.
		requestAnimationFrame(() => requestAnimationFrame(() => measureInteraction(sample, "paintMs")));
	}
}
export const interactionTimings = () => samples.map((sample) => ({ ...sample }));
