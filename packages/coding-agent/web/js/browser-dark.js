// Dark mode of websites in the built-in browser (desktop app; the host runs Dark Reader's engine, see
// packages/desktop/browser-dark.cjs). In "auto" mode a site is dark while the app is: this module tells the host whether
// the app is dark and which background and text colors it uses, so a recolored site looks like part of the app.

const hex = (value) => {
	const text = String(value || "").trim();
	if (/^#[0-9a-f]{6}$/iu.test(text)) return text;
	const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/iu.exec(text);
	return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : undefined;
};

export function installBrowserDarkSync() {
	const host = globalThis.myHarnessDesktop;
	if (!host?.browser) return;
	let last = "";
	const report = () => {
		const root = document.documentElement;
		const style = getComputedStyle(root);
		const appDark = root.dataset.theme === "dark";
		const colors = { background: hex(style.getPropertyValue("--bg-panel")), text: hex(style.getPropertyValue("--text")) };
		const key = JSON.stringify([appDark, colors]);
		if (key === last) return;
		last = key;
		host.browser({ action: "darkMode", appDark, colors }).catch(() => {
			last = "";
		});
	};
	// The display mode and the color theme are attributes of <html> (boot-theme.js, settings).
	new MutationObserver(report).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-color-theme"] });
	report();
}
