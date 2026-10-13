import { post, toast, activeSlotId, subscribe } from "./store.js";
import { t } from "./i18n.js";
import { isLocalAutolinkBlocked, pathCandidates } from "./local-file-links.js";

/**
 * `unbound/memory/...` is shorthand for `data/workspaces/unbound/memory/...`.
 * The backend resolves relative paths against the workspace root (C:/myharness),
 * where `unbound/...` does not exist, so try the data-dir prefix as a fallback.
 * Display text stays `unbound/...`; only the link target becomes the absolute path.
 */
function fallbackResolvePaths(path) {
	if (/^unbound[\\/]/i.test(path)) return [`data/workspaces/${path.replace(/\\/g, "/")}`];
	return [];
}

function targetFor(candidatePath, resolved) {
	const direct = resolved.get(candidatePath);
	if (direct) return direct;
	for (const fallback of fallbackResolvePaths(candidatePath)) {
		const hit = resolved.get(fallback);
		if (hit) return hit;
	}
	return undefined;
}

export const localFileAction = (path, action, handler, slot) => post("/api/files/local", { path, action, handler }, slot);
export const openLocalFile = (path, slot) => localFileAction(path, "open", undefined, slot).catch((error) => toast(error.message, "error"));
let closeMenu;
// A dismissed menu stays mounted for --t-close (composer.css) so it fades out instead of vanishing; opening a new menu drops every fading one at once.
const MENU_EXIT_MS = 110;
let exiting = null;
const dropExiting = () => {
	if (!exiting) return;
	clearTimeout(exiting.timer);
	exiting.menu.remove();
	exiting = null;
};
export async function showLocalFileMenu(event, path, slot) {
	event.preventDefault();
	closeMenu?.();
	dropExiting();
	const focus = event.target.closest?.("[data-local-path]") || event.target;
	const menu = document.createElement("div");
	menu.className = "local-file-menu";
	menu.setAttribute("role", "menu");
	menu.style.left = `${event.clientX}px`;
	menu.style.top = `${event.clientY}px`;
	let submenu = null;
	let submenuOwner = null;
	let hoverTimer;
	const closeSubmenu = () => {
		clearTimeout(hoverTimer);
		submenu?.remove();
		submenuOwner?.setAttribute("aria-expanded", "false");
		submenu = null;
		submenuOwner = null;
	};
	const contains = (node) => menu.contains(node) || submenu?.contains(node);
	const status = document.createElement("div");
	status.className = "local-file-menu-status";
	status.textContent = t("Loading…");
	menu.append(status);
	document.body.append(menu);
	let closed = false;
	// Listeners stop the moment closing starts, so a fade-out can never trigger a second dismiss or eat a click.
	const detach = () => {
		document.removeEventListener("pointerdown", outside, true);
		window.removeEventListener("keydown", keys, true);
		window.removeEventListener("scroll", scroll, true);
		window.removeEventListener("resize", dismiss);
		window.removeEventListener("blur", checkAlive);
		window.removeEventListener("focus", checkAlive);
		document.removeEventListener("visibilitychange", checkAlive);
		unsubscribe();
		observer?.disconnect();
		if (focus?.isConnected) focus.focus?.({ preventScroll: true });
	};
	const dismiss = () => {
		if (closed) return;
		closed = true;
		closeSubmenu();
		detach();
		if (closeMenu === dismissNow) closeMenu = undefined;
		menu.classList.add("closing");
		const timer = setTimeout(() => {
			menu.remove();
			if (exiting?.timer === timer) exiting = null;
		}, MENU_EXIT_MS);
		exiting = { menu, timer };
	};
	// A menu replaced by a newer one leaves at once: two context menus must never stack.
	const dismissNow = () => {
		if (closed) return;
		closed = true;
		closeSubmenu();
		detach();
		if (closeMenu === dismissNow) closeMenu = undefined;
		menu.remove();
	};
	const outside = (e) => { if (!contains(e.target)) dismiss(); };
	const scroll = (e) => { if (!contains(e.target)) dismiss(); };
	const keys = (e) => {
		if (e.key === "Escape" || e.key === "ArrowLeft") {
			e.preventDefault();
			if (submenu) { const owner = submenuOwner; closeSubmenu(); owner?.focus(); }
			else if (e.key === "Escape") dismiss();
			return;
		}
		if (e.key === "Tab") { dismiss(); return; }
		if (e.key === "ArrowRight") {
			const button = document.activeElement;
			if (menu.contains(button) && button.hasAttribute("aria-haspopup")) { e.preventDefault(); button.click(); }
			return;
		}
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
		e.preventDefault();
		const panel = submenu?.contains(document.activeElement) ? submenu : menu;
		const buttons = [...panel.querySelectorAll("button:not(:disabled)")];
		const current = buttons.indexOf(document.activeElement);
		const index = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (current + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
		buttons[index]?.focus();
	};
	// Event-driven stand-in for the old 200ms poll: whenever a moment arrives where the outcome could
	// have changed (focus returned to the window, the tab became visible, the DOM moved, the store
	// emitted), the same isConnected/activeSlot check runs; a mere window blur never dismisses.
	const checkAlive = () => { if (!focus?.isConnected || activeSlotId() !== slot) dismiss(); };
	const unsubscribe = subscribe(checkAlive);
	let observer = null;
	if (typeof MutationObserver !== "undefined" && focus && typeof focus.isConnected === "boolean") {
		try {
			observer = new MutationObserver(checkAlive);
			observer.observe(document.body, { childList: true, subtree: true });
		} catch {
			observer = null;
		}
	}
	closeMenu = dismissNow;
	document.addEventListener("pointerdown", outside, true);
	window.addEventListener("keydown", keys, true);
	window.addEventListener("scroll", scroll, true);
	window.addEventListener("resize", dismiss);
	window.addEventListener("blur", checkAlive);
	window.addEventListener("focus", checkAlive);
	document.addEventListener("visibilitychange", checkAlive);
	const add = (label, run, panel = menu) => {
		const button = document.createElement("button");
		button.className = "local-file-menu-item";
		button.type = "button";
		button.setAttribute("role", "menuitem");
		button.textContent = label;
		button.onclick = () => { dismiss(); Promise.resolve().then(run).catch((error) => toast(error.message, "error")); };
		button.onpointerenter = () => { clearTimeout(hoverTimer); if (panel === menu) closeSubmenu(); };
		panel.append(button);
		return button;
	};
	const separator = (panel) => {
		const line = document.createElement("div");
		line.className = "local-file-menu-separator";
		line.setAttribute("role", "separator");
		panel.append(line);
	};
	const branch = (label, populate) => {
		const button = add(label, () => {});
		button.setAttribute("aria-haspopup", "menu");
		button.setAttribute("aria-expanded", "false");
		const arrow = document.createElement("span");
		arrow.className = "local-file-menu-arrow";
		arrow.setAttribute("aria-hidden", "true");
		button.append(arrow);
		const expand = (keyboard = false) => {
			clearTimeout(hoverTimer);
			if (submenuOwner !== button) {
				closeSubmenu();
				submenuOwner = button;
				submenu = document.createElement("div");
				submenu.className = "local-file-menu local-file-submenu";
				submenu.setAttribute("role", "menu");
				submenu.setAttribute("aria-label", label);
				button.setAttribute("aria-expanded", "true");
				populate(submenu);
				document.body.append(submenu);
				const anchor = button.getBoundingClientRect();
				const parent = menu.getBoundingClientRect();
				const size = submenu.getBoundingClientRect();
				const left = parent.right + size.width > window.innerWidth - 8 ? parent.left - size.width - 2 : parent.right + 2;
				submenu.style.left = `${Math.max(8, left)}px`;
				submenu.style.top = `${Math.max(8, Math.min(anchor.top - 5, window.innerHeight - size.height - 8))}px`;
				submenu.onpointerenter = () => clearTimeout(hoverTimer);
				submenu.onpointerleave = () => { hoverTimer = setTimeout(closeSubmenu, 250); };
			}
			if (keyboard) submenu.querySelector("button")?.focus();
		};
		button.onclick = () => expand(true);
		button.onpointerenter = () => expand();
		button.onpointerleave = () => { hoverTimer = setTimeout(closeSubmenu, 250); };
	};
	try {
		const target = await localFileAction(path, "choices", undefined, slot);
		if (closed) return;
		menu.replaceChildren();
		branch(t("Copy"), (panel) => {
			add(t("File name"), () => navigator.clipboard.writeText(target.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop()), panel);
			add(t("Full path"), () => navigator.clipboard.writeText(target.path), panel);
		});
		separator(menu);
		branch(t("Open in"), (panel) => {
			add(t("Default app"), () => localFileAction(target.path, "open", undefined, slot), panel);
			if (target.choices?.length) separator(panel);
			for (const choice of target.choices || []) add(choice.label, () => localFileAction(target.path, "handler", choice.id, slot), panel);
		});
		add(t(target.directory ? "Open in File Explorer" : "Show in File Explorer"), () => localFileAction(target.path, "reveal", undefined, slot));
	} catch (error) {
		if (closed) return;
		status.textContent = error.message;
		add(t("Copy path"), () => navigator.clipboard.writeText(path));
	}
	if (closed) return;
	const rect = menu.getBoundingClientRect();
	menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
	menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
	menu.querySelector("button")?.focus();
}

/** Existing paths only; skip fenced code and existing anchors. Resolve at most four concurrently. */
export async function linkifyLocalFiles(root, slot, isCurrent) {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const jobs = [];
	while (walker.nextNode()) {
		const node = walker.currentNode;
		if (!node.textContent || node.parentElement?.closest("a, pre, button, .code-head")) continue;
		const code = node.parentElement?.closest("code");
		if (code && node.textContent === code.textContent) {
			// Inline code: the whole `` `...` `` may be a path with spaces (e.g. `C:/My Dir/a.txt`),
			// so keep it as a candidate first; if it does not exist, fall back to paths inside it
			// (e.g. `` `C:/a/b/ 42张` `` links only `C:/a/b/`, `42张` stays outside the link).
			const text = node.textContent;
			if (!text.trim()) continue;
			const inner = pathCandidates(text);
			const whole = { start: 0, end: text.length, path: text };
			const seen = new Set([`${whole.start}:${whole.end}:${whole.path}`]);
			const raw = [whole];
			for (const item of inner) {
				const key = `${item.start}:${item.end}:${item.path}`;
				if (seen.has(key)) continue;
				seen.add(key);
				raw.push(item);
			}
			const candidates = raw.filter((candidate) => {
				const check = candidate === whole ? candidate.path.trim() : candidate.path;
				return check && !isLocalAutolinkBlocked(check);
			});
			if (candidates.length) jobs.push({ node, text, candidates, whole: true });
			continue;
		}
		const candidates = pathCandidates(node.textContent).filter((candidate) => !isLocalAutolinkBlocked(candidate.path));
		if (candidates.length) jobs.push({ node, text: node.textContent, candidates, whole: false });
	}
	const wanted = new Set();
	for (const job of jobs) {
		for (const candidate of job.candidates) {
			wanted.add(candidate.path);
			if (job.whole && job.candidates[0] === candidate) wanted.add(candidate.path.trim());
			for (const fallback of fallbackResolvePaths(candidate.path)) wanted.add(fallback);
		}
	}
	const resolved = new Map();
	let index = 0;
	const paths = [...wanted].slice(0, 150);
	const resolveOne = async (path) => {
		try { resolved.set(path, await localFileAction(path, "resolve", undefined, slot)); } catch { /* Nonexistent paths stay ordinary text. */ }
		if (path !== path.trim()) {
			try {
				const trimmed = path.trim();
				if (trimmed && !resolved.has(trimmed)) resolved.set(trimmed, await localFileAction(trimmed, "resolve", undefined, slot));
			} catch { /* trimmed variant also missing */ }
		}
	};
	await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
		while (index < paths.length && isCurrent() && activeSlotId() === slot) {
			const path = paths[index++];
			await resolveOne(path);
		}
	}));
	if (!isCurrent() || activeSlotId() !== slot) return;
	for (const { node, text, candidates, whole } of jobs) {
		if (!node.isConnected || node.textContent !== text) continue;
		let render = candidates;
		if (whole && candidates.length > 1) {
			// Prefer the whole `` `...` `` when it really exists (paths with spaces);
			// otherwise link only the paths inside it so trailing `42张 +` stays out.
			const first = candidates[0];
			const wholeTarget = targetFor(first.path, resolved) || targetFor(first.path.trim(), resolved);
			if (wholeTarget) render = [first];
			else render = candidates.slice(1);
		}
		const fragment = document.createDocumentFragment();
		let offset = 0;
		let found = false;
		for (const candidate of render) {
			const target = targetFor(candidate.path, resolved) || targetFor(candidate.path.trim(), resolved);
			if (!target) continue;
			// Skip overlapping candidates left by whole+inner lists.
			if (candidate.start < offset || candidate.end > text.length || candidate.start >= candidate.end) continue;
			found = true;
			fragment.append(document.createTextNode(text.slice(offset, candidate.start)));
			const link = document.createElement("a");
			link.href = "#";
			link.className = "path-code";
			link.dataset.localPath = target.path;
			link.title = target.path;
			link.textContent = text.slice(candidate.start, candidate.end);
			fragment.append(link);
			offset = candidate.end;
		}
		if (found) { fragment.append(document.createTextNode(text.slice(offset))); node.replaceWith(fragment); }
	}
	// Paths that cannot be resolved (e.g. model-abbreviated `518d9582.../memory/`) stay plain
	// code, but keep the full text on hover so a wrapped path is still readable.
	for (const code of root.querySelectorAll?.("code") || []) {
		if (code.querySelector?.("a[data-local-path]")) continue;
		const text = code.textContent || "";
		if (text.length > 512 || text.length < 3) continue;
		if (!/[\\/:]/.test(text) || !/[\\/]/.test(text)) continue;
		if (!code.title) code.title = text;
	}
}
