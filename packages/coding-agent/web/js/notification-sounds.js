// The built-in notification sounds, synthesised with the Web Audio API so no audio files ship with the page. All three
// are short, low in volume and made of soft sine tones with a slow attack, so they stay pleasant when heard often.

/** Sound ids as the server stores them (setting `notificationSound`); "off" plays nothing. */
export const NOTIFICATION_SOUNDS = ["soft", "chime", "glow"];

// Each note: when it starts (s), its pitch (Hz), how long it rings (s), its peak level.
const SOUNDS = {
	// Two rising soft notes (G5, C6).
	soft: [
		{ at: 0, freq: 784, length: 0.55, gain: 0.13 },
		{ at: 0.13, freq: 1047, length: 0.7, gain: 0.11 },
	],
	// A single bell-like note (E6) with a quiet overtone.
	chime: [
		{ at: 0, freq: 1319, length: 1.1, gain: 0.12 },
		{ at: 0, freq: 2637, length: 0.55, gain: 0.025 },
	],
	// A gentle rising arpeggio (C5, E5, G5), each note a soft sine with a quiet octave above it.
	glow: [
		{ at: 0, freq: 523, length: 0.6, gain: 0.1 },
		{ at: 0, freq: 1047, length: 0.35, gain: 0.015 },
		{ at: 0.12, freq: 659, length: 0.6, gain: 0.1 },
		{ at: 0.12, freq: 1319, length: 0.35, gain: 0.015 },
		{ at: 0.24, freq: 784, length: 0.9, gain: 0.1 },
		{ at: 0.24, freq: 1568, length: 0.5, gain: 0.015 },
	],
};

let context;

function audioContext() {
	if (context) return context;
	const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
	if (!Context) return undefined;
	try {
		context = new Context();
	} catch {
		context = undefined;
	}
	return context;
}

/** Plays a sound by id. Quietly does nothing for "off", an unknown id, or a browser that will not play audio. */
export function playNotificationSound(id) {
	const notes = SOUNDS[id];
	const ctx = notes && audioContext();
	if (!ctx) return;
	try {
		// A context made before the user touched the page starts suspended; resuming is a no-op once it is running.
		ctx.resume?.();
		const start = ctx.currentTime + 0.02;
		for (const note of notes) {
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			const at = start + note.at;
			osc.type = "sine";
			osc.frequency.setValueAtTime(note.freq, at);
			// Slow attack and long decay: no click at the start or the end.
			gain.gain.setValueAtTime(0.0001, at);
			gain.gain.exponentialRampToValueAtTime(note.gain, at + 0.03);
			gain.gain.exponentialRampToValueAtTime(0.0001, at + note.length);
			osc.connect(gain).connect(ctx.destination);
			osc.start(at);
			osc.stop(at + note.length + 0.05);
		}
	} catch {
		// A sound that cannot play never blocks the notification itself.
	}
}
