import { Component, h, render } from "/vendor/preact.js";
import { useLayoutEffect, useRef, useState } from "/vendor/preact-hooks.js";
import { App } from "./app.js";
import { boot, state, subscribe, version } from "./store.js";
import { t } from "./i18n.js";

// A rendering bug must never leave a blank page: show the error and let the user reload.
class ErrorBoundary extends Component {
	state = { error: null };
	componentDidCatch(error) {
		console.error("Web UI render error", error);
		this.setState({ error });
	}
	render(props, { error }) {
		if (!error) return props.children;
		return h(
			"div",
			{ class: "splash" },
			h(
				"div",
				{ class: "splash-card" },
				h("h2", null, t("The interface hit an error")),
				h("pre", { class: "git-lines err", style: "max-width:100%;white-space:pre-wrap" }, String(error?.stack || error)),
				h("div", { class: "dim" }, t("Your session and running task are not affected; they live in the MyHarness server.")),
				h("button", { class: "btn primary", onClick: () => location.reload() }, t("Reload")),
			),
		);
	}
}

// Re-render the whole tree when any part of the store changes; components use memoization
// and selector hooks so only the parts that changed do real work.
function Root() {
	const [, force] = useState(0);
	const seen = useRef(version);
	useLayoutEffect(() => {
		const update = () => {
			seen.current = version;
			force((n) => n + 1);
		};
		if (version !== seen.current) update();
		return subscribe(update);
	}, []);
	// The language is part of the key: switching it rebuilds the interface so every text is drawn again in the new language.
	return h(ErrorBoundary, null, h(App, { key: state.view.lang }));
}

render(h(Root, null), document.getElementById("app"));
boot();
