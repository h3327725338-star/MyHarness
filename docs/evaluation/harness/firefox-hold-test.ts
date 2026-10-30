// No model and no outside network: how long does a process stay alive after it used MyHarness's shared headless Firefox?
// node --import file:///C:/myharness/scripts/dev-fast-loader.mjs firefox-hold-test.ts <none|load|load-shutdown>
import { getSharedFirefoxBrowser } from "file:///C:/myharness/packages/coding-agent/src/tools/web-search/browser/firefox.ts";

const mode = process.argv[2] ?? "load";
const t0 = Date.now();
if (mode !== "none") {
	const browser = getSharedFirefoxBrowser();
	const page = await browser.load({ url: "http://127.0.0.1:47823/" } as never);
	console.log(mode, "page loaded after", Math.round((Date.now() - t0) / 1000), "s, status", (page as { status?: number }).status);
	if (mode === "load-shutdown") await browser.shutdown();
}
const last = Date.now();
console.log(mode, "work done; nothing else to do, waiting for a natural exit");
process.on("exit", () => {
	console.log(mode, "process exited", Math.round((Date.now() - last) / 1000), "s after the work finished");
});
