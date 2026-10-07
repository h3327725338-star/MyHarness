import { post, toast, activeSlotId } from "./store.js";
import { t } from "./i18n.js";
import { pathCandidates } from "./local-file-links.js";

export const localFileAction = (path, action, handler, slot) => post("/api/files/local", { path, action, handler }, slot);
export const openLocalFile = (path, slot) => localFileAction(path, "open", undefined, slot).catch((error) => toast(error.message, "error"));
let closeMenu;
export async function showLocalFileMenu(event, path, slot) {
	event.preventDefault();
	closeMenu?.();
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
	const dismiss = () => {
		closed = true;
		closeSubmenu();
		menu.remove();
		document.removeEventListener("pointerdown", outside, true);
		window.removeEventListener("keydown", keys, true);
		window.removeEventListener("scroll", scroll, true);
		window.removeEventListener("resize", dismiss);
		clearInterval(chatCheck);
		if (focus?.isConnected) focus.focus?.({ preventScroll: true });
		if (closeMenu === dismiss) closeMenu = undefined;
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
	const chatCheck = setInterval(() => { if (!focus?.isConnected || activeSlotId() !== slot) dismiss(); }, 200);
	closeMenu = dismiss;
	document.addEventListener("pointerdown", outside, true);
	window.addEventListener("keydown", keys, true);
	window.addEventListener("scroll", scroll, true);
	window.addEventListener("resize", dismiss);
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
		const candidates = code && node.textContent === code.textContent ? [{ start: 0, end: node.textContent.length, path: node.textContent }] : pathCandidates(node.textContent);
		if (candidates.length) jobs.push({ node, text: node.textContent, candidates });
	}
	const resolved = new Map();
	let index = 0;
	const paths = [...new Set(jobs.flatMap((job) => job.candidates.map((candidate) => candidate.path)))].slice(0, 150);
	await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
		while (index < paths.length && isCurrent() && activeSlotId() === slot) {
			const path = paths[index++];
			try { resolved.set(path, await localFileAction(path, "resolve", undefined, slot)); } catch { /* Nonexistent paths stay ordinary text. */ }
		}
	}));
	if (!isCurrent() || activeSlotId() !== slot) return;
	for (const { node, text, candidates } of jobs) {
		if (!node.isConnected || node.textContent !== text) continue;
		const fragment = document.createDocumentFragment();
		let offset = 0;
		let found = false;
		for (const candidate of candidates) {
			const target = resolved.get(candidate.path);
			if (!target) continue;
			found = true;
			fragment.append(document.createTextNode(text.slice(offset, candidate.start)));
			const link = document.createElement("a");
			link.href = "#";
			link.dataset.localPath = target.path;
			link.title = target.path;
			link.textContent = text.slice(candidate.start, candidate.end);
			fragment.append(link);
			offset = candidate.end;
		}
		if (found) { fragment.append(document.createTextNode(text.slice(offset))); node.replaceWith(fragment); }
	}
}
