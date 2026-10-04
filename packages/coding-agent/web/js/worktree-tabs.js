// Keep references across menu lifetimes. Named windows allow reuse after the main page reloads.
const tabs = new Map();
const urls = new Map();
export async function openWorktreeTab(path, start) {
	let tab = tabs.get(path);
	if (tab && !tab.closed) {
		const service = await start();
		if (urls.get(path) !== service.url) tab.location = service.url;
		urls.set(path, service.url);
		tab.focus();
		return;
	}
	// Open synchronously in the click gesture, before the asynchronous startup request.
	tab = window.open("", `myharness-copy-${encodeURIComponent(path)}`);
	if (!tab) throw new Error("Allow popups to open the copy tab.");
	tabs.set(path, tab);
	try {
		const service = await start();
		tab.location = service.url;
		urls.set(path, service.url);
		tab.focus();
	} catch (error) {
		tab.close();
		tabs.delete(path);
		throw error;
	}
}
