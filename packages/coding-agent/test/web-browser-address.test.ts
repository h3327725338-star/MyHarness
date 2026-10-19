import { describe, expect, it } from "vitest";

// The address bar's decision (address vs. search) is a plain ES module; load it through a computed URL like the other
// web tests. It is the only place that turns what the user typed into the URL the desktop host is asked to open.
const address = await import(new URL("../web/js/browser-address.js", import.meta.url).href);

const memory = () => {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
	};
};

describe("built-in browser: the address bar", () => {
	it("opens a real address as it is", () => {
		expect(address.resolveBrowserAddress("https://example.com/a?b=1", "google")).toEqual({
			kind: "url",
			url: "https://example.com/a?b=1",
		});
		expect(address.resolveBrowserAddress("  http://example.com  ", "google")).toEqual({
			kind: "url",
			url: "http://example.com/",
		});
	});

	it("adds https to a bare host, so a typed address does not have to spell the scheme", () => {
		expect(address.resolveBrowserAddress("example.com", "bing")).toEqual({
			kind: "url",
			url: "https://example.com/",
		});
		expect(address.resolveBrowserAddress("example.com/path?q=1", "bing")).toEqual({
			kind: "url",
			url: "https://example.com/path?q=1",
		});
		expect(address.resolveBrowserAddress("localhost:3000/app", "bing")?.kind).toBe("url");
		expect(address.resolveBrowserAddress("192.168.0.4", "bing")?.kind).toBe("url");
	});

	it("searches everything that is not an address, in the chosen engine", () => {
		const query = "deepseek v4 价格";
		const google = address.resolveBrowserAddress(query, "google");
		const bing = address.resolveBrowserAddress(query, "bing");
		expect(google).toEqual({
			kind: "search",
			url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
			query,
		});
		expect(bing).toEqual({
			kind: "search",
			url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
			query,
		});
		// A single word, a number and a file name are queries: only a real address opens as a page.
		expect(address.resolveBrowserAddress("deepseek", "google")?.kind).toBe("search");
		expect(address.resolveBrowserAddress("1.5", "google")?.kind).toBe("search");
		expect(address.resolveBrowserAddress("how do i reset a router", "google")?.kind).toBe("search");
	});

	it("never opens a scheme the host would have to trust, and never sends credentials", () => {
		expect(address.resolveBrowserAddress("file:///C:/Windows/win.ini", "google")?.kind).toBe("search");
		expect(address.resolveBrowserAddress("javascript:alert(1)", "google")?.kind).toBe("search");
		expect(address.resolveBrowserAddress("data:text/html,<h1>x</h1>", "google")?.kind).toBe("search");
		expect(address.resolveBrowserAddress("https://user:secret@example.com/", "google")?.kind).toBe("search");
	});

	it("does nothing for an empty bar", () => {
		expect(address.resolveBrowserAddress("", "google")).toBe(null);
		expect(address.resolveBrowserAddress("   ", "google")).toBe(null);
		expect(address.resolveBrowserAddress(null, "google")).toBe(null);
	});

	it("remembers the engine in the page's storage and falls back to Google", () => {
		const storage = memory();
		expect(address.savedSearchEngine(storage).id).toBe("google");
		address.rememberSearchEngine(storage, "bing");
		expect(address.savedSearchEngine(storage).id).toBe("bing");
		expect(address.savedSearchEngine(memory()).id).toBe("google");
		// An id this version does not know must not break the bar.
		address.rememberSearchEngine(storage, "engine-from-a-future-version");
		expect(address.savedSearchEngine(storage).id).toBe("google");
		// Storage that refuses to work (private mode) still yields a usable engine.
		expect(
			address.savedSearchEngine({
				getItem: () => {
					throw new Error("denied");
				},
			}).id,
		).toBe("google");
		expect(() =>
			address.rememberSearchEngine(
				{
					setItem: () => {
						throw new Error("denied");
					},
				},
				"bing",
			),
		).not.toThrow();
	});
});
