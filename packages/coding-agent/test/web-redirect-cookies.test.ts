import { expect, it } from "vitest";
import { RedirectCookies } from "../src/tools/web-search/redirect-cookies.ts";

it("honours path boundaries, Secure, expiry, deletion and rejects foreign domains", () => {
	const jar = new RedirectCookies();
	const headers = new Headers();
	for (const cookie of [
		"a=1; Path=/",
		"b=2; Path=/private; Secure",
		"expired=3; Max-Age=0",
		"foreign=4; Domain=other.example",
		"parent=5; Domain=example.com; Path=/",
	])
		headers.append("Set-Cookie", cookie);
	jar.store("https://login.example.com/private/start", headers);
	expect(jar.header("https://login.example.com/private/page")).toBe("b=2; a=1; parent=5");
	expect(jar.header("http://login.example.com/private/page")).toBe("a=1; parent=5");
	expect(jar.header("https://login.example.com/private-other")).toBe("a=1; parent=5");
	expect(jar.header("https://other.example.com/private/page")).toBe("");
	jar.store("https://login.example.com/", new Headers({ "Set-Cookie": "a=; Path=/; Max-Age=0" }));
	expect(jar.header("https://login.example.com/")).toBe("parent=5");
});
