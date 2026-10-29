import { afterEach, describe, expect, it } from "vitest";
import { mailRouteContext, resetMailRouteCache } from "../src/tools/mail/route-context.ts";
import type { DesktopWorkspaceChannel } from "../src/tools/workspace.ts";

function host(answer: () => unknown) {
	const asked: unknown[] = [];
	const channel = {
		request: async (command: Record<string, unknown>) => {
			asked.push(command);
			return answer();
		},
	} as unknown as DesktopWorkspaceChannel;
	return { channel, asked };
}

afterEach(() => resetMailRouteCache());

describe("the mail route note", () => {
	it("points to the mail tool while a mailbox is connected through its API, without asking the host", async () => {
		const { channel, asked } = host(() => ({ google: { signedIn: true, account: "me@example.com" } }));
		const note = await mailRouteContext([], () => [{ provider: "google", email: "me@example.com" }], channel);
		expect(note?.content).toContain("Mailboxes connected to the mail tool through their API: me@example.com (Gmail)");
		expect(note?.details).toMatchObject({ v: 1, accounts: 1 });
		expect(asked).toEqual([]);
	});

	it("sends mail through the mail tool and the rest to the built-in browser's web mail when no mailbox is connected", async () => {
		const { channel, asked } = host(() => ({
			google: { signedIn: true, account: "me@example.com" },
			microsoft: { signedIn: false },
		}));
		const note = await mailRouteContext([], () => [], channel, 1_000);
		expect(note?.content).toContain("No mailbox is connected to the mail tool");
		// Sending still goes through the mail tool (the website, by MyHarness itself); the Agent never fills the form.
		expect(note?.content).toContain("with only message (to, subject, text) and no path");
		expect(note?.content).toContain("never fill the website's compose form yourself");
		expect(note?.content).toContain("Gmail as me@example.com (https://mail.google.com/)");
		expect(note?.content).not.toContain("https://outlook.office.com/mail/");
		expect(asked).toEqual([{ action: "webMail" }]);
		// The same route is not sent again; the host's answer is reused for a while.
		expect(await mailRouteContext([note?.details], () => [], channel, 2_000)).toBeUndefined();
		expect(asked).toHaveLength(1);
		// A mailbox connected later changes the route.
		const later = await mailRouteContext(
			[note?.details],
			() => [{ provider: "microsoft", email: "me@example.org" }],
			channel,
			3_000,
		);
		expect(later?.content).toContain("me@example.org (Outlook)");
	});

	it("lists both web mail sites when the host does not answer, and adds nothing without a desktop host", async () => {
		const { channel } = host(() => {
			throw new Error("the desktop host did not answer within 1s (webMail)");
		});
		const note = await mailRouteContext([], () => [], channel);
		expect(note?.content).toContain("Gmail https://mail.google.com/");
		expect(note?.content).toContain("Outlook https://outlook.office.com/mail/");
		expect(await mailRouteContext([], () => [], undefined)).toBeUndefined();
		// A mail store that cannot be read counts as no mailbox.
		const broken = await mailRouteContext(
			[],
			() => {
				throw new Error("damaged");
			},
			channel,
		);
		expect(broken?.content).toContain("No mailbox is connected");
	});
});
