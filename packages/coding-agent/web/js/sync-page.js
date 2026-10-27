// Google Drive sync settings: connection, background status, restored-workspace bindings and versions kept for review.
// Every row uses the same pieces as the rest of Settings: cards for groups, one compact line per setting.
import { html, useEffect, useState, Collapse, Icon, Spinner, Toggle } from "./ui.js";
import { api, post, set, toast, useStore } from "./store.js";
import { t } from "./i18n.js";
import { connectionBadge, deriveSync, footLine, progressText, reviewTitle, stateLine } from "./sync-status.js";
import { confirmDialog } from "./actions.js";

function Card({ title, description, action, children, id }) {
	return html`<section class="set-card" id=${id || undefined}>
		<div class="set-card-head"><div class="col grow"><strong>${title}</strong>${description ? html`<span class="set-card-desc">${description}</span>` : null}</div>${action || null}</div>
		<div class="set-card-body">${children}</div>
	</section>`;
}

/** `wide`: the control takes its own full-width line under the name, for values too long for the right column. */
function Row({ label, description, children, stack, wide }) {
	return html`<div class=${`set-row ${stack ? "stack" : ""} ${wide ? "wide" : ""}`}><div class="set-text"><span class="set-label">${label}</span>${description ? html`<span class="set-desc">${description}</span>` : null}</div><div class="set-control">${children}</div></div>`;
}

function formatBytes(value) {
	const bytes = Number(value) || 0;
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function timeText(value) {
	if (!value) return t("Not yet");
	try {
		return new Date(value).toLocaleString();
	} catch {
		return value;
	}
}

let jumpTimer = 0;
function jumpTo(id) {
	const el = (id && document.getElementById(id)) || null;
	if (!el) return;
	el.scrollIntoView({ block: "start", behavior: "smooth" });
	// The settings page is often already scrolled as far as it goes, so the jump itself can look like nothing happened.
	// Outlining the section for a moment shows where the click went even then.
	clearTimeout(jumpTimer);
	for (const node of document.querySelectorAll(".sync-hit")) node.classList.remove("sync-hit");
	el.classList.add("sync-hit");
	jumpTimer = setTimeout(() => el.classList.remove("sync-hit"), 1600);
}

/** A waiting count; while that stage moves it shows how far the pass got, with a bar that follows it. */
function SyncCount({ status, stage, text }) {
	const progress = progressText(status, stage);
	if (!progress) return html`<span class="mono">${text}</span>`;
	const { done, total, step } = status.progress;
	const percent = Math.round((Math.min(done, total) / total) * 100);
	// Change lists are read before anything is downloaded; without the word the count looks like files arriving.
	const label = step === "read" ? t("Reading changes") : "";
	return html`<span class="sync-count" role="status" title=${label ? `${label} ${progress}` : progress}>
		<span>${label ? html`<span class="dim">${label} </span>` : null}<span class="mono">${progress}</span></span>
		<span class="sync-meter" role="progressbar" aria-valuemin="0" aria-valuemax=${total} aria-valuenow=${Math.min(done, total)}><i style=${{ width: `${percent}%` }} /></span>
	</span>`;
}

/**
 * The built-in browser (desktop app only). Bookmarks, shortcuts and site settings ride on the normal sync; sign-ins and
 * saved passwords only once a sync passphrase seals them on this computer (packages/desktop/browser-sync.cjs).
 */
function BrowserSyncCard({ syncing }) {
	const host = globalThis.myHarnessDesktop;
	const [state, setState] = useState(null);
	const [phrase, setPhrase] = useState("");
	const [busy, setBusy] = useState("");
	useEffect(() => {
		let live = true;
		const load = () =>
			host
				.browser({ action: "syncStatus" })
				.then((value) => live && setState(value))
				.catch(() => {});
		void load();
		const timer = setInterval(load, 15_000);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, []);
	const run = async (key, command, success) => {
		setBusy(key);
		try {
			setState(await host.browser(command));
			if (success) toast(t(success), "success");
			return true;
		} catch (error) {
			toast(error?.message || t("The operation failed."), "error", 7000);
			return false;
		} finally {
			setBusy("");
		}
	};
	const on = state?.on === true;
	// Today's seal by its clock time, an older one by its date: the line has to fit beside the button.
	const sealedAt = state?.lastSealAt ? new Date(state.lastSealAt) : null;
	const sealed = sealedAt
		? t("Sealed {time}", {
				time:
					sealedAt.toDateString() === new Date().toDateString()
						? sealedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
						: sealedAt.toLocaleDateString(),
			})
		: t("Not sealed yet");
	return html`<${Card} title=${t("Built-in browser")} description=${t("Your browser data follows you to your other computers.")}>
		<${Row} label=${t("Bookmarks, shortcuts and site settings")} description=${t("Zoom, dark mode, website language and site permissions too. Nothing to set up.")}>
			<span class="dim">${syncing ? t("On") : t("Off")}</span>
		<//>
		<${Row}
			label=${t("Sign-ins and saved passwords")}
			description=${on
				? t("Sealed with your sync passphrase before upload. Some sites, such as Google, may ask you to sign in again.")
				: t("Encrypted on this computer with a sync passphrase before upload; use the same one on each computer. Some sites, such as Google, may ask you to sign in again.")}
			wide=${!on}
		>
			${on
				? html`<div class="row sync-field">
						<span class="dim truncate grow" role="status" title=${state?.others ? t("{count} other computers have sealed theirs", { count: state.others }) : ""}>${sealed}</span>
						<button class="btn" disabled=${busy === "off"} onClick=${() => run("off", { action: "syncOff" }, "Sign-in sync is off on this computer.")}>${t("Turn off")}</button>
					</div>`
				: html`<form
						class="row sync-field"
						onSubmit=${async (event) => {
							event.preventDefault();
							if (await run("on", { action: "syncPassphrase", passphrase: phrase }, "Sign-in sync is on.")) setPhrase("");
						}}
					>
						<input
							class="field grow"
							type="password"
							value=${phrase}
							minlength="8"
							placeholder=${t("Sync passphrase, at least 8 characters")}
							autocomplete="new-password"
							disabled=${state && !state.available}
							onInput=${(event) => setPhrase(event.target.value)}
						/>
						<button class="btn primary" type="submit" disabled=${busy === "on" || phrase.length < 8 || (state && !state.available)}>${busy === "on" ? t("Verifying…") : t("Turn on")}</button>
					</form>`}
		<//>
		${state?.unreadable?.length
			? html`<div class="notice warn">${t("This passphrase does not open the sign-ins from {names}. Enter the same passphrase on every computer.", { names: state.unreadable.join(", ") })}</div>`
			: null}
	<//>`;
}

export function SyncPage() {
	const status = useStore((s) => s.syncStatus);
	const [busy, setBusy] = useState("");
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [deviceName, setDeviceName] = useState("");
	const [clientTouched, setClientTouched] = useState(false);
	const [deviceTouched, setDeviceTouched] = useState(false);
	const [detailsOpen, setDetailsOpen] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			try {
				const data = await api("/api/sync/state", { timeoutMs: 10_000 });
				if (!cancelled && data?.status) set({ syncStatus: data.status });
			} catch {
				// The polling pass simply tries again; the page keeps the last state it had.
			}
		};
		void refresh();
		const timer = setInterval(refresh, 2500);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);

	useEffect(() => {
		if (!status) return;
		if (!clientTouched) setClientId(status.clientConfigured ? (status.clientId ?? "") : "");
		if (!deviceTouched) setDeviceName(status.deviceName ?? "");
	}, [status?.deviceName, status?.clientConfigured, status?.clientId]);

	const run = async (key, action, success) => {
		setBusy(key);
		try {
			const result = await action();
			if (result?.status) set({ syncStatus: result.status });
			if (success) toast(t(success), "success");
			return result;
		} catch (error) {
			toast(error?.message || t("The operation failed."), "error", 7000);
			return null;
		} finally {
			setBusy("");
		}
	};

	if (!status) return html`<div class="row"><${Spinner} /></div>`;

	const sync = deriveSync(status);
	const badge = connectionBadge(status, sync);
	const state = stateLine(status, sync);
	const folder = status.folder;
	const account = status.account;
	const risk = status.externalRisk ?? { detected: false };
	const files = sync.files;
	const fileWorkspaces = sync.workspaces;
	const fileConflicts = sync.fileConflicts;
	const pendingBindings = sync.pendingBindings;
	const conflicts = sync.review;

	const manual = status.manual ?? null;
	// Pause means nothing is uploaded or applied; the manual runs respect it instead of overriding it.
	const manualBlocked = !status.connected || status.paused || manual?.state === "running";

	const saveConfig = (patch) => run("config", () => post("/api/sync/config", patch));

	const connect = () =>
		run(
			"connect",
			async () => {
				const result = await post("/api/sync/connect");
				toast(t("Finish the Google sign-in in the browser. This page updates by itself."), "info", 8000);
				return result;
			},
			null,
		);

	const disconnect = async () => {
		const ok = await confirmDialog({
			title: t("Disconnect Google Drive?"),
			message: t("Sync stops on this computer. Local chats and memories stay; the cloud copy is not deleted."),
			confirmLabel: t("Disconnect"),
			danger: true,
		});
		if (ok) await run("disconnect", () => post("/api/sync/disconnect"), "Google Drive disconnected.");
	};

	// A browser window that was closed leaves the pending flow waiting for its timeout; this clears it at once.
	const cancelWait = () => run("disconnect", () => post("/api/sync/disconnect"), "Authorization canceled.");

	const chooseFolder = async (workspaceId) => {
		setBusy(`bind:${workspaceId}`);
		let pickedPath = "";
		try {
			const picked = await post("/api/fs/pick-folder", { title: t("Choose this workspace's folder") });
			if (!picked?.path) return;
			pickedPath = picked.path;
			const result = await post("/api/sync/bind", { workspaceId, rootPath: picked.path });
			if (result?.status) set({ syncStatus: result.status });
			toast(t("Workspace folder bound."), "success");
		} catch (error) {
			// A folder can be held by a Workspace that was removed from the sidebar. Offer the one safe action:
			// move the hidden record's binding to an internal folder, keep its chats, and retry the bind.
			if (pickedPath) {
				const answer = await post("/api/sync/occupancy", { workspaceId, rootPath: pickedPath }).catch(() => null);
				const occupant = answer?.occupancy;
				if (occupant?.hidden) {
					const ok = await confirmDialog({
						title: t("This folder is held by a hidden workspace"),
						message: t(
							"{name} ({id}) was removed from the sidebar but still keeps {count} chats. Releasing it moves only its folder binding to an internal folder; its chats stay reachable and its files do not move.",
							{ name: occupant.name, id: occupant.workspaceId, count: occupant.chatCount },
						),
						confirmLabel: t("Release and bind"),
					});
					if (ok) {
						await post("/api/sync/release-occupant", {
							workspaceId: occupant.workspaceId,
							confirmed: true,
						});
						const result = await post("/api/sync/bind", { workspaceId, rootPath: pickedPath });
						if (result?.status) set({ syncStatus: result.status });
						toast(t("Workspace folder bound."), "success");
						return;
					}
				}
			}
			toast(error?.message || t("The operation failed."), "error", 7000);
		} finally {
			setBusy("");
		}
	};

	const enableFiles = async (workspaceId) => {
		setBusy(`files:${workspaceId}`);
		try {
			const answer = await post("/api/sync/workspace-source", { workspaceId });
			const source = answer?.source ?? {};
			if (source.provider) {
				// Another client already syncs this folder; two writers on the same files is exactly the failure mode we refuse.
				toast(
					t("This folder is inside {provider}. Turn that client's sync off for it first, or keep it managed there.", {
						provider: source.provider,
					}),
					"error",
					9000,
				);
				return;
			}
			if (source.source === "drive" && source.driveRootId && source.driveRelativePath) {
				const result = await post("/api/sync/files/enable", {
					workspaceId,
					source: "drive",
					driveRootId: source.driveRootId,
					driveRelativePath: source.driveRelativePath,
				});
				if (result?.status) set({ syncStatus: result.status });
				toast(t("File sync is on. This folder stays owned by the Google Drive client."), "success", 6000);
				return;
			}
			const preview = await post("/api/sync/files/preflight", { workspaceId });
			const scan = preview?.preflight;
			if (!scan?.ok) throw new Error(scan?.error || t("The workspace folder is not available."));
			const ok = await confirmDialog({
				title: t("Upload this folder to Google Drive?"),
				message: t(
					"{files} files ({size}) will be uploaded from {path}. Excluded: {excluded}. Possible secret files found: {secrets}.",
					{
						files: scan.files,
						size: formatBytes(scan.bytes),
						path: scan.path,
						excluded: (scan.excluded ?? []).join(", "),
						secrets: (scan.secrets ?? []).length,
					},
				),
				confirmLabel: t("Start syncing files"),
			});
			if (!ok) return;
			const result = await post("/api/sync/files/enable", { workspaceId, source: "local", confirmed: true });
			if (result?.status) set({ syncStatus: result.status });
			toast(t("File sync is on. The first upload runs in the background."), "success", 6000);
		} catch (error) {
			toast(error?.message || t("The operation failed."), "error", 7000);
		} finally {
			setBusy("");
		}
	};

	const disableFiles = async (workspaceId) => {
		const ok = await confirmDialog({
			title: t("Stop syncing this folder's files?"),
			message: t("Files stay where they are. Changes stop being uploaded or applied on this computer."),
			confirmLabel: t("Stop syncing files"),
			danger: true,
		});
		if (!ok) return;
		setBusy(`files:${workspaceId}`);
		try {
			const result = await post("/api/sync/files/disable", { workspaceId });
			if (result?.status) set({ syncStatus: result.status });
			toast(t("File sync stopped for this workspace."), "info");
		} catch (error) {
			toast(error?.message || t("The operation failed."), "error", 7000);
		} finally {
			setBusy("");
		}
	};

	const resolveFileConflict = async (conflict, choice) => {
		setBusy(`conflict:${conflict.id}`);
		try {
			const result = await post("/api/sync/files/resolve", {
				workspaceId: conflict.workspaceId,
				conflictId: conflict.id,
				choice,
			});
			if (result?.status) set({ syncStatus: result.status });
			toast(t("The choice is saved. This computer publishes it as a new version."), "success");
		} catch (error) {
			toast(error?.message || t("The operation failed."), "error", 7000);
		} finally {
			setBusy("");
		}
	};

	const confirmFileDeletes = async (workspaceId) => {
		const ok = await confirmDialog({
			title: t("Confirm the waiting deletions?"),
			message: t("Other computers will delete these files too. A copy is kept under the agent folder first."),
			confirmLabel: t("Delete on every computer"),
			danger: true,
		});
		if (!ok) return;
		setBusy(`deletes:${workspaceId}`);
		try {
			const result = await post("/api/sync/files/confirm-deletes", { workspaceId });
			if (result?.status) set({ syncStatus: result.status });
			toast(t("The deletions are confirmed and queued for upload."), "info");
		} catch (error) {
			toast(error?.message || t("The operation failed."), "error", 7000);
		} finally {
			setBusy("");
		}
	};

	const foot = footLine(manual, status, sync);

	return html`
		${risk.detected ? html`<div class="notice danger">${t(risk.message ?? "The operation failed.")}</div>` : null}
		<${Card}
			title=${t("Status")}
			description=${t("What is moving, what is stuck, and what needs you.")}
			action=${html`<span class=${`badge ${badge.cls}`}>${badge.text}</span>`}
		>
			<${Row}
				label=${t("Current state")}
				description=${t("{up} to upload · {down} to download · {count} to review", { up: sync.up, down: sync.down, count: sync.unresolved })}
			>
				<strong>${state}</strong>
			<//>
		<//>
		<${Card}
			title=${t("Google Drive")}
			description=${t("Chats, memories and attachments sync through MyHarness's own folder in your Drive.")}
		>
			<${Row}
				label=${t("Account")}
				description=${account?.email ||
					(status.clientConfigured && status.clientSecretConfigured
						? t("No Google account is connected on this computer.")
						: t("Paste the client id and secret of a Google Cloud desktop OAuth client first."))}
			>
				${status.connected
					? html`<button class="btn" disabled=${busy === "disconnect"} onClick=${disconnect}>${t("Disconnect")}</button>`
					: html`<button class="btn primary" disabled=${busy === "connect" || !status.clientConfigured || !status.clientSecretConfigured} onClick=${connect}>${busy === "connect" ? t("Opening…") : t("Connect Google Drive")}</button>`}
				${status.phase === "authorizing"
					? html`<button class="btn" disabled=${busy === "disconnect"} onClick=${cancelWait}>${t("Cancel waiting")}</button>`
					: null}
			<//>
			${folder
				? html`<${Row} label=${t("Cloud folder")} description=${t("Renaming it in Drive does not break the connection.")}>
						<a class="btn" href=${folder.url} target="_blank" rel="noreferrer" data-link-system><${Icon} name="drive" size=${14} />${folder.name}</a>
					<//>`
				: null}
			<${Row}
				label=${t("OAuth client id")}
				description=${t("Paste the client ID of a Google Cloud desktop OAuth client.")}
				wide=${true}
			>
				<div class="row sync-field">
					<input
						class="field grow"
						value=${clientId}
						placeholder="1234567890-…apps.googleusercontent.com"
						spellcheck="false"
						autocomplete="off"
						onInput=${(event) => {
							setClientTouched(true);
							setClientId(event.target.value);
						}}
					/>
					<button
						class="btn"
						disabled=${busy === "client" || !clientId.trim() || clientId.trim() === (status.clientId ?? "")}
						onClick=${async () => {
							setClientTouched(false);
							await run("client", () => post("/api/sync/config", { clientId: clientId.trim() }));
						}}
					>${t("Save")}</button>
				</div>
			<//>
			<${Row}
				label=${t("OAuth client secret")}
				description=${status.clientSecretConfigured
					? t("A secret is saved on this computer. Paste a new one only to replace it.")
					: t("Google rejects the token exchange without it, even with PKCE.")}
				wide=${true}
			>
				<div class="row sync-field">
					<input
						class="field grow"
						type="password"
						value=${clientSecret}
						placeholder=${status.clientSecretConfigured ? "••••••••" : "GOCSPX-…"}
						spellcheck="false"
						autocomplete="off"
						onInput=${(event) => setClientSecret(event.target.value)}
					/>
					<button
						class="btn"
						disabled=${busy === "secret" || !clientSecret.trim()}
						onClick=${async () => {
							const result = await run(
								"secret",
								() => post("/api/sync/config", { clientSecret: clientSecret.trim() }),
								"Client secret saved.",
							);
							if (result) setClientSecret("");
						}}
					>${t("Save")}</button>
				</div>
			<//>
			<${Row} label=${t("This device")} description=${t("Shown on the other computers when they report progress.")}>
				<div class="row sync-field">
					<input
						class="field"
						value=${deviceName}
						maxlength="80"
						spellcheck="false"
						onInput=${(event) => {
							setDeviceTouched(true);
							setDeviceName(event.target.value);
						}}
					/>
					<button
						class="btn"
						disabled=${busy === "device" || !deviceName.trim() || deviceName.trim() === status.deviceName}
						onClick=${async () => {
							setDeviceTouched(false);
							await run("device", () => post("/api/sync/config", { deviceName: deviceName.trim() }));
						}}
					>${t("Save")}</button>
				</div>
			<//>
		<//>
		<${Card} title=${t("Automatic sync")} description=${t("Changes upload after a short pause; other computers are checked in the background.")}>
			<${Row} label=${t("Sync with Google Drive")} description=${t("Off keeps every local change on this computer only.")}>
				<${Toggle}
					checked=${status.enabled}
					disabled=${!status.connected || busy === "config"}
					label=${t("Sync with Google Drive")}
					onChange=${(value) => saveConfig({ enabled: value })}
				/>
			<//>
			<${Row} label=${t("Pause")} description=${t("Keeps the connection and the waiting work; nothing is uploaded or applied while paused.")}>
				<${Toggle}
					checked=${status.paused}
					disabled=${!status.enabled || busy === "config"}
					label=${t("Pause sync")}
					onChange=${(value) => saveConfig({ paused: value })}
				/>
			<//>
			<${Row} label=${t("Waiting to upload")} description=${t("Saved on this computer, not uploaded yet.")}>
				<${SyncCount} status=${status} stage="upload" text=${sync.up > 0 ? `${sync.up} · ${formatBytes(status.pendingBytes)}` : t("Nothing waiting")} />
			<//>
			<${Row} label=${t("Waiting to download")} description=${t("Changes from other computers, not applied here yet.")}>
				<${SyncCount} status=${status} stage="download" text=${sync.down > 0 ? `${sync.down}` : t("Nothing waiting")} />
			<//>
			<${Row} label=${t("Last check")}>
				<span class="dim">${timeText(status.lastCheckAt)}</span>
			<//>
			<${Row} label=${t("Last upload")} description=${t("Uploaded is not the same as received by another computer.")}>
				<span class="dim">${timeText(status.lastUploadAt)}</span>
			<//>
			<${Row} label=${t("Last download")}>
				<span class="dim">${timeText(status.lastDownloadAt)}</span>
			<//>
			${status.lastError ? html`<div class="notice danger">${t(status.lastError)}</div>` : null}
			${(status.issues ?? []).length > 0
				? html`<div class="notice warn sync-list" id="sync-issues">
						<strong>${t("Some changes are waiting for a manual look")}</strong>
						${sync.issues.slice(-5).map((issue) => html`<div key=${issue.key}>${issue.detail || issue.reason} <span class="dim">· ${timeText(issue.at)}</span></div>`)}
					</div>`
				: null}
			<div class="row sync-foot">
				<button class="btn" disabled=${!status.connected || busy === "check"} onClick=${() => run("check", () => post("/api/sync/check"))}>
					<${Icon} name="refresh" size=${14} />${t("Check now")}
				</button>
				<button class="btn" disabled=${manualBlocked || busy === "download"} title=${status.paused ? t("Sync is paused. Turn Pause off first.") : ""} onClick=${() => run("download", () => post("/api/sync/download"))}>
					<${Icon} name="download" size=${14} />${t("Download now")}
				</button>
				<button
					class="btn"
					disabled=${manualBlocked || busy === "sync"}
					title=${status.paused ? t("Sync is paused. Turn Pause off first.") : ""}
					onClick=${() =>
						run("sync", async () => {
							// The built-in browser seals its sign-ins first, so this pass uploads them too.
							await globalThis.myHarnessDesktop?.browser?.({ action: "syncNow" }).catch(() => {});
							return post("/api/sync/sync");
						})}
				>
					<${Icon} name="drive" size=${14} />${t("Sync now")}
				</button>
			</div>
				${foot
					? html`<div class="sync-runline" role="status" title=${foot.text}>
							${foot.spinning ? html`<${Spinner} />` : null}<span class=${`grow truncate ${foot.tone === "danger" ? "c-danger" : foot.tone === "warn" ? "c-warn" : ""}`}>${foot.text}</span>
							${foot.review ? html`<button class="btn sm" onClick=${() => jumpTo(foot.target)}>${t("Review")}</button>` : null}
						</div>`
					: html`<div class="sync-runline dim" role="status">${t("Everything also runs by itself; this button is for troubleshooting.")}</div>`}
		<//>
		${fileWorkspaces.length
			? html`<${Card} title=${t("Workspace files")} id="sync-files" description=${t("Each workspace records who syncs its files. A finished chat upload never proves that its folder is fully uploaded.")}>
					${fileWorkspaces.map(
						(item) => html`<${Row} key=${item.workspaceId} label=${item.name} description=${item.path || ""} stack=${true}>
							<div class="row sync-field">
								<span class="dim grow truncate" role="status" title=${item.message}>${item.message}</span>
								${item.managed
									? html`<button class="btn" disabled=${busy === `files:${item.workspaceId}`} onClick=${() => disableFiles(item.workspaceId)}>${t("Stop syncing files")}</button>`
									: item.source === "drive"
										? null
										: html`<button class="btn" disabled=${busy === `files:${item.workspaceId}`} onClick=${() => enableFiles(item.workspaceId)}>${t("Sync files")}</button>`}
							</div>
							${item.receiving
								? html`<span class="dim">${t("Receiving {done} of {total} files ({size} so far).", { done: item.receiving.done, total: item.receiving.total, size: formatBytes(item.receiving.bytes) })}</span>`
								: null}
							${item.state === "blocked"
								? html`<button class="btn danger" disabled=${busy === `deletes:${item.workspaceId}`} onClick=${() => confirmFileDeletes(item.workspaceId)}>${t("Confirm the waiting deletions")}</button>`
								: null}
						<//>`,
					)}
					${files?.historyNote ? html`<div class="set-desc">${t(files.historyNote)}</div>` : null}
				<//>`
			: null}
		${fileConflicts.length
			? html`<${Card} title=${t("File conflicts")} id="sync-conflicts" description=${t("Nothing was overwritten. Choose what becomes the new version; the other computers then receive it.")}>
					${fileConflicts.slice(0, 20).map(
						(conflict) => html`<div class="set-row stack" key=${conflict.id}>
							<div class="set-text">
								<span class="set-label">${conflict.path}</span>
								<span class="set-desc">${t(conflict.message)}</span>
								${conflict.remoteCopyPath ? html`<span class="dim mono truncate" title=${conflict.remoteCopyPath}>${conflict.remoteCopyPath}</span>` : null}
								<span class="dim">${conflict.deviceName} · ${timeText(conflict.at)}</span>
							</div>
							<div class="set-control row">
								<button class="btn" disabled=${busy === `conflict:${conflict.id}`} onClick=${() => resolveFileConflict(conflict, "keep-local")}>${t("Keep this computer's version")}</button>
								<button class="btn" disabled=${!conflict.remoteCopyPath || busy === `conflict:${conflict.id}`} onClick=${() => resolveFileConflict(conflict, "take-remote")}>${t("Use the other version")}</button>
								<button class="btn" disabled=${busy === `conflict:${conflict.id}`} onClick=${() => resolveFileConflict(conflict, "keep-both")}>${t("Keep both")}</button>
							</div>
						</div>`,
					)}
				<//>`
			: null}
		${pendingBindings.length
			? html`<${Card} title=${t("Workspaces restored to a managed folder")} id="sync-bindings" description=${t("Pick the folder this computer should use. Chats and memories already work; file tools wait for the binding.")}>
					${pendingBindings.map(
						(item) => html`<${Row} key=${item.workspaceId} label=${item.name} description=${item.hint || item.path} stack=${true}>
							<div class="row sync-field"><span class="dim mono truncate grow" title=${item.path}>${item.path}</span>
								<button class="btn" disabled=${busy === `bind:${item.workspaceId}`} onClick=${() => chooseFolder(item.workspaceId)}>${t("Choose folder")}</button>
							</div>
						<//>`,
					)}
				<//>`
			: null}
		${conflicts.length
			? html`<${Card} title=${t("Kept for review")} id="sync-review" description=${t("Nothing was overwritten. The local version is in use; the other version is saved beside the agent data.")}>
					${conflicts.slice(0, 20).map(
						(conflict) => html`<div class="set-row stack" key=${conflict.id}>
							<div class="set-text"><span class="set-label">${reviewTitle(conflict)}</span><span class="set-desc">${t(conflict.message)}</span></div>
							<div class="set-control sync-paths">
								<span class="dim mono truncate" title=${conflict.localPath || ""}>${conflict.localPath || ""}</span>
								${conflict.remoteCopyPath ? html`<span class="dim mono truncate" title=${conflict.remoteCopyPath}>${conflict.remoteCopyPath}</span>` : null}
								<span class="dim">${conflict.deviceName} · ${timeText(conflict.at)}</span>
							</div>
						</div>`,
					)}
				<//>`
			: null}
		${typeof globalThis.myHarnessDesktop?.browser === "function" ? html`<${BrowserSyncCard} syncing=${status.connected && status.enabled && !status.paused} />` : null}
		<${Card} title=${t("What syncs")} description=${t("Scanned by meaning, never by copying the whole Data folder.")}>
			<button class="set-card-toggle" aria-expanded=${detailsOpen} onClick=${() => setDetailsOpen(!detailsOpen)}>
				<${Icon} name="chevronRight" size=${13} class="disclose" /><span class="set-label">${detailsOpen ? t("Hide details") : t("Show details")}</span>
			</button>
			<${Collapse} open=${detailsOpen}>
				<div class="set-desc sync-list">
					<div>${t("All memories: global, workspace, session, archived, pending and the profile.")}</div>
					<div>${t("General mode: workspaces, chats and branches, attachments, artifacts, library files, drafts and the general personal prompt.")}</div>
					<div>${t("Built-in browser: bookmarks, new-tab shortcuts and site settings; sign-ins and saved passwords only with a sync passphrase, sealed on this computer first.")}</div>
					<div>${t("Coding-mode chats and repositories are not uploaded; their memories are.")}</div>
					<div>${t("API keys, Google tokens, trust decisions, locks and running tasks never leave this computer.")}</div>
					<div>${t("The Google token is kept in an owner-only file (Windows user permissions). It is not OS-encrypted or end-to-end encrypted.")}</div>
				</div>
			<//>
		<//>`;
}
