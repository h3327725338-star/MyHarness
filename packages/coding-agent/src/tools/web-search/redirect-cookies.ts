import { parseCookie } from "undici";

interface RedirectCookie {
	name: string;
	value: string;
	host: string;
	path: string;
	secure: boolean;
	expires: number;
}

/** Request-local cookies: never shared between page reads or sent to a different host. */
export class RedirectCookies {
	private readonly cookies = new Map<string, RedirectCookie>();

	store(url: string, headers: Headers): void {
		const source = new URL(url);
		for (const value of headers.getSetCookie()) {
			const cookie = parseCookie(value);
			if (!cookie) continue;
			// Deliberately host-scope Domain cookies too: an HTTP redirect must not leak credentials to sibling sites.
			const domain = cookie.domain?.replace(/^\./u, "").toLowerCase();
			if (domain && source.hostname !== domain && !source.hostname.endsWith(`.${domain}`)) continue;
			const path = cookie.path?.startsWith("/")
				? cookie.path
				: source.pathname.slice(0, source.pathname.lastIndexOf("/")) || "/";
			const key = JSON.stringify([source.hostname, path, cookie.name]);
			const expires =
				cookie.maxAge !== undefined
					? Date.now() + cookie.maxAge * 1000
					: cookie.expires instanceof Date
						? cookie.expires.getTime()
						: (cookie.expires ?? Infinity);
			if (expires <= Date.now()) this.cookies.delete(key);
			else
				this.cookies.set(key, {
					name: cookie.name,
					value: cookie.value,
					host: source.hostname,
					path,
					secure: !!cookie.secure,
					expires,
				});
		}
	}

	header(url: string): string {
		const target = new URL(url);
		return [...this.cookies.values()]
			.filter(
				(cookie) =>
					cookie.host === target.hostname &&
					cookie.expires > Date.now() &&
					(!cookie.secure || target.protocol === "https:") &&
					(target.pathname === cookie.path ||
						target.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`)),
			)
			.sort((a, b) => b.path.length - a.path.length)
			.map((cookie) => `${cookie.name}=${cookie.value}`)
			.join("; ");
	}
}
