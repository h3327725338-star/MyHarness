/**
 * The OAuth apps MyHarness itself is registered with. Google and Microsoft give Drive and mailbox access only to a
 * registered app; with MyHarness's own app a user just signs in, with nothing to create or paste. An app the user set up
 * (Settings → Connections → Advanced, Settings → Google Drive → Advanced) or an environment variable
 * (`MYHARNESS_GOOGLE_CLIENT_ID`, `MYHARNESS_MICROSOFT_CLIENT_ID`) still takes precedence.
 *
 * - google: the OAuth client "MyHarness Desktop" (type "Desktop app") in MyHarness's Google Cloud project, whose consent
 *   screen is published (In production). It serves Google Drive sync, whose scopes (`openid`, `email`, `profile`,
 *   `drive.file`) are non-sensitive: no verification, no unverified-app warning and no user cap. It does not serve Gmail
 *   yet: Gmail's scope (`https://mail.google.com/`) is restricted, and until Google has verified the app for it a
 *   sign-in would show the unverified-app warning and count toward a lifetime cap of 100 users, so Gmail keeps using the
 *   user's own app or the mailbox website. Google's token endpoint requires the client secret even with PKCE; for an
 *   installed app it is not a confidential value (the app cannot keep one), which is why it is written here. The release
 *   audit exempts exactly this value (`REVIEWED_PUBLIC_VALUES` in scripts/release-audit.mjs, docs/RELEASE_GATE.md); a
 *   new secret needs its hash there too.
 * - microsoft: none yet. It would be an Entra app registration for "Accounts in any organizational directory and
 *   personal Microsoft accounts" with the platform "Mobile and desktop applications" and the redirect URI
 *   http://localhost; a public client has no secret.
 *
 * Setup and limits: packages/coding-agent/docs/settings.md, "MyHarness's own OAuth apps".
 */
export type BuiltInOAuthProvider = "google" | "microsoft";

/** What a built-in app is published for: Google Drive sync, or mailbox access. */
export type BuiltInOAuthUse = "sync" | "mail";

export interface OAuthAppIdentity {
	clientId: string;
	clientSecret?: string;
}

interface BuiltInOAuthApp extends OAuthAppIdentity {
	uses: readonly BuiltInOAuthUse[];
}

const BUILT_IN_OAUTH_APPS: Readonly<Record<BuiltInOAuthProvider, BuiltInOAuthApp | undefined>> = {
	google: {
		clientId: "128503014751-r0tm14am6edsa5evk8o0s9jj7rmpsnv0.apps.googleusercontent.com",
		clientSecret: "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",
		uses: ["sync"],
	},
	microsoft: undefined,
};

/** MyHarness's own app of a provider for one use, or undefined when this build has none for it. */
export function builtInOAuthApp(provider: BuiltInOAuthProvider, use: BuiltInOAuthUse): OAuthAppIdentity | undefined {
	const app = BUILT_IN_OAUTH_APPS[provider];
	if (!app?.clientId.trim() || !app.uses.includes(use)) return undefined;
	return { clientId: app.clientId, ...(app.clientSecret ? { clientSecret: app.clientSecret } : {}) };
}
