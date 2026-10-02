// One terminal on screen: xterm.js draws a shell that runs on the server (src/modes/web/terminal.ts) and sends it what is
// typed. The shell outlives this view: showing it again starts from what it has written so far.
import { activeSlotId, onTerminalEvent, post } from "./store.js";

let modules;
/** xterm.js is loaded when the first terminal is shown, not with the page. */
function loadXterm() {
	modules ??= Promise.all([import("/vendor/xterm.js"), import("/vendor/xterm-addon-fit.js")]).then(
		([xterm, fit]) => ({ Terminal: xterm.Terminal, FitAddon: fit.FitAddon }),
		(error) => {
			modules = undefined;
			throw error;
		},
	);
	return modules;
}

// The 16 terminal colours of each theme, in the hues the rest of the interface uses. "Black" and "white" are the ends of
// the theme's own scale: programs also use them as backgrounds.
const PALETTE = {
	dark: {
		black: "#2b2d2d", red: "#e06c6c", green: "#63c08a", yellow: "#d9b95b", blue: "#6f9bf0", magenta: "#b98ae0", cyan: "#5cc2c8", white: "#c8cccc",
		brightBlack: "#7a8080", brightRed: "#f08a8a", brightGreen: "#83d9a6", brightYellow: "#ecd07a", brightBlue: "#8fb3f7", brightMagenta: "#cfa8ee", brightCyan: "#7edbe0", brightWhite: "#f0f2f2",
	},
	light: {
		black: "#1d2020", red: "#c8433c", green: "#2c8a5c", yellow: "#9a6a00", blue: "#2c66d6", magenta: "#8a3fb8", cyan: "#12796a", white: "#565c5c",
		brightBlack: "#808686", brightRed: "#d6564e", brightGreen: "#35a06c", brightYellow: "#b06f12", brightBlue: "#4a7fe0", brightMagenta: "#a25bd0", brightCyan: "#1a9482", brightWhite: "#a4aaaa",
	},
};

function pageTheme() {
	const root = document.documentElement;
	const css = getComputedStyle(root);
	const value = (name) => css.getPropertyValue(name).trim();
	return {
		...PALETTE[root.dataset.theme === "light" ? "light" : "dark"],
		background: value("--code-bg"),
		foreground: value("--text"),
		cursor: value("--text"),
		cursorAccent: value("--code-bg"),
		selectionBackground: value("--selection-bg"),
	};
}

const isTextField = (el) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

/**
 * Shows the terminal of `shell` (a shell id) in the folder of the chat on screen, inside the element `mount`.
 * `onState({ phase, exitCode, error })` says what the view should tell the user: "starting", "running", "exited"
 * (`exitCode` is null when the terminal was ended, not the shell's own exit) or "error".
 * Returns `{ restart, end, focus, dispose }`.
 */
export function openTerminalView(mount, { shell, instance, onState }) {
	let disposed = false;
	let term = null;
	let fit = null;
	let id = null;
	let lastSeq = 0;
	let phase = "starting";
	// Events that arrive while the terminal's state is being fetched; they are applied after it.
	let waiting = null;
	let ticket = 0;
	// What the stored output makes xterm.js answer (a program once asked where the cursor is) must not be typed again.
	let replaying = false;
	let outbox = "";
	let sending = false;
	let sizeTimer = 0;
	const cleanups = [];

	const setPhase = (next, extra = {}) => {
		phase = next;
		if (!disposed) onState({ phase: next, exitCode: null, error: "", ...extra });
	};

	const fitNow = () => {
		if (disposed || !term || !mount.clientWidth || !mount.clientHeight) return;
		try {
			fit.fit();
		} catch {
			// Not measurable yet (the panel is being laid out); the next size change fits it.
		}
	};

	/** Tells the server the size on screen, once it has stopped changing. */
	const pushSize = () => {
		clearTimeout(sizeTimer);
		sizeTimer = setTimeout(() => {
			if (!disposed && id && phase === "running") post("/api/terminal/resize", { id, cols: term.cols, rows: term.rows }, "").catch(() => {});
		}, 60);
	};

	/** Sends what was typed, in order: one request at a time, with everything typed meanwhile in the next one. */
	const flushInput = async () => {
		if (sending) return;
		sending = true;
		try {
			while (outbox && id && !disposed) {
				const data = outbox;
				const target = id;
				outbox = "";
				const result = await post("/api/terminal/input", { id: target, data }, "");
				if (!result?.ok && target === id && phase === "running") setPhase("exited");
			}
		} catch (error) {
			outbox = "";
			setPhase("error", { error: error.message });
		} finally {
			sending = false;
		}
	};

	const handle = (type, data) => {
		if (disposed || !term) return;
		if (type === "reconnect") {
			// Output may have been missed while the connection was down.
			if (id && !waiting && phase !== "error") attach({ quiet: true });
			return;
		}
		if (waiting) {
			waiting.push([type, data]);
			return;
		}
		if (data.id !== id) return;
		if (type === "exit") {
			setPhase("exited", { exitCode: data.exitCode });
		} else if (data.seq > lastSeq) {
			if (data.seq !== lastSeq + 1) {
				attach({ quiet: true });
				return;
			}
			lastSeq = data.seq;
			term.write(data.data);
		}
	};

	const show = (snapshot) => {
		id = snapshot.id;
		lastSeq = snapshot.seq;
		if (snapshot.windowsPty) term.options.windowsPty = snapshot.windowsPty;
		term.reset();
		// The stored output was written for the shell's size: it is drawn at that size first, then fitted to this view.
		if (snapshot.cols !== term.cols || snapshot.rows !== term.rows) term.resize(snapshot.cols, snapshot.rows);
		replaying = true;
		term.write(snapshot.buffer, () => {
			replaying = false;
			fitNow();
			pushSize();
		});
		setPhase(snapshot.exitCode === null ? "running" : "exited", { exitCode: snapshot.exitCode });
		const queued = waiting || [];
		waiting = null;
		for (const [type, data] of queued) handle(type, data);
	};

	/**
	 * Fetches the terminal from the server and shows it. `restart` ends the running shell and starts a new one; `quiet`
	 * refreshes the terminal that is on screen (after missed output) without saying "starting".
	 */
	async function attach({ restart = false, quiet = false } = {}) {
		const mine = ++ticket;
		waiting = [];
		outbox = "";
		if (!quiet) setPhase("starting");
		try {
			const snapshot = await post("/api/terminal/open", { shell, instance, cols: term.cols, rows: term.rows, restart, attached: !restart ? id : undefined }, activeSlotId());
			if (disposed || mine !== ticket) return;
			show(snapshot);
		} catch (error) {
			if (disposed || mine !== ticket) return;
			waiting = null;
			setPhase("error", { error: error.message });
		}
	}

	(async () => {
		try {
			const { Terminal, FitAddon } = await loadXterm();
			if (disposed) return;
			const css = getComputedStyle(document.documentElement);
			term = new Terminal({
				fontFamily: css.getPropertyValue("--font-mono").trim() || "monospace",
				fontSize: Number.parseFloat(css.getPropertyValue("--fs-code")) || 12.5,
				cursorBlink: true,
				scrollback: 5000,
				// Programs pick colours for a dark console; this keeps their text readable on either theme.
				minimumContrastRatio: 4.5,
				theme: pageTheme(),
			});
			fit = new FitAddon();
			term.loadAddon(fit);
			term.open(mount);
			fitNow();

			// Windows conventions: Ctrl+C copies when text is selected (and interrupts otherwise), Ctrl+V pastes.
			term.attachCustomKeyEventHandler((event) => {
				if (event.type !== "keydown" || !event.ctrlKey || event.altKey || event.metaKey) return true;
				const key = event.key.toLowerCase();
				if (key === "c" && (event.shiftKey || term.hasSelection())) {
					event.preventDefault();
					if (term.hasSelection()) navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
					term.clearSelection();
					return false;
				}
				// Left to the browser: its paste event reaches xterm.js, which hands the text to the shell.
				if (key === "v") return false;
				return true;
			});
			term.onData((data) => {
				if (replaying) return;
				if (phase === "running") {
					outbox += data;
					flushInput();
				} else if (phase === "exited" && data.includes("\r")) {
					attach({ restart: true });
				}
			});
			term.onResize(pushSize);
			cleanups.push(onTerminalEvent(handle));

			if (typeof ResizeObserver !== "undefined") {
				let frame = 0;
				let settle = 0;
				const observer = new ResizeObserver(() => {
					cancelAnimationFrame(frame);
					clearTimeout(settle);
					// Fitting re-flows the whole screen buffer and resizes the shell. While an edge is being dragged the
					// terminal keeps its size (clipped by its box) and is fitted once, when the width has come to rest.
					if (document.querySelector(".resizer.dragging")) settle = setTimeout(fitNow, 140);
					else frame = requestAnimationFrame(fitNow);
				});
				observer.observe(mount);
				cleanups.push(() => (observer.disconnect(), cancelAnimationFrame(frame), clearTimeout(settle)));
			}
			// The page's theme can change while the terminal is open.
			let themeShown = document.documentElement.dataset.theme;
			const themeObserver = new MutationObserver(() => {
				if (document.documentElement.dataset.theme === themeShown) return;
				themeShown = document.documentElement.dataset.theme;
				term.options.theme = pageTheme();
			});
			themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
			cleanups.push(() => themeObserver.disconnect());
			// Keys typed into the terminal belong to the shell, not to the page's shortcuts (Ctrl+B, Ctrl+N, …).
			const ownKeys = (event) => event.stopPropagation();
			mount.addEventListener("keydown", ownKeys);
			cleanups.push(() => mount.removeEventListener("keydown", ownKeys));

			if (!isTextField(document.activeElement)) term.focus();
			await attach();
		} catch (error) {
			setPhase("error", { error: error.message });
		}
	})();

	return {
		restart: () => term && attach({ restart: true }),
		/** Start again after the shell has exited or could not be started. */
		retry: () => term && attach({ restart: true }),
		end: () => id && phase === "running" && post("/api/terminal/close", { id }, "").catch(() => {}),
		focus: () => term?.focus(),
		dispose: () => {
			disposed = true;
			clearTimeout(sizeTimer);
			for (const cleanup of cleanups) cleanup();
			term?.dispose();
		},
	};
}
