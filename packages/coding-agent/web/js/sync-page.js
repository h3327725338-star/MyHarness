// Google Drive sync settings: connection, background status, restored-workspace bindings and versions kept for review.
// Every row uses the same pieces as the rest of Settings: cards for groups, one compact line per setting.
import { html, useEffect, useState, Icon, Spinner, Toggle } from "./ui.js";
import { api, post, set, toast, useStore } from "./store.js";
import { t } from "./i18n.js";
import { confirmDialog } from "./actions.js";

function Card({ title, description, action, children }) {
	return html`<section class="set-card">
		<div class="set-card-head"><div class="col grow"><strong>${title}</strong>${description ? html`<span class="set-card-desc">${description}</span>` : null}</div>${action || null}</div>
		<div class="set-card-body">${children}</div>
	</section>`;
}

function Row({ label, description, children, stack }) {
	return html`<div class=${`set-row ${stack ? "stack" : ""}`}><div class="set-text"><span class="set-label">${label}</span>${description ? html`<span class="set-desc">${description}</span>` : null}</div><div class="set-control">${children}</div></div>`;
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

function connectionBadge(status) {
	if (!status.connected) return { cls: "", text: t("Not connected") };
	if (status.phase === "authorizing") return { cls: "warn", text: t("Waiting for Google") };
	if (status.phase === "error") return { cls: "danger", text: t("Needs attention") };
	if (status.phase === "locked") return { cls: "warn", text: t("Another process") };
	if (status.paused) return { cls: "warn", text: t("Paused") };
	if (!status.enabled) return { cls: "", text: t("Connected, sync off") };
	return { cls: "ok", text: t("Syncing") };
}

/** One line for the last manual Download now / Sync now run: what is moving, how far, or why it stopped. */
function manualText(manual, status) {
	if (manual.state === "running") {
		if (manual.stage === "waiting") {
			// Waiting is not a dead end: say what the pass in flight is doing and how much is left, so the button can be
			// read as "this is running", not as "this is stuck".
			const phase = status?.phase;
			if (phase === "downloading") {
				return t("Waiting for the current sync pass to finish (downloading, {count} batches left).", {
					count: Number(status?.pendingDownloads) || 0,
				});
			}
			if (phase === "uploading") {
				return t("Waiting for the current sync pass to finish (uploading, {count} changes left).", {
					count: Number(status?.pendingUploads) || 0,
				});
			}
			return t("Waiting for the current sync pass to finish…");
		}
		const progress = manual.total > 0 ? ` ${manual.done} / ${manual.total}` : "";
		return manual.stage === "upload" ? `${t("Uploading…")}${progress}` : `${t("Downloading…")}${progress}`;
	}
	if (manual.state === "failed") return `${t("Failed")}: ${t(manual.error || "The operation failed.")}`;
	const done = manual.kind === "download" ? t("Download finished.") : t("Sync finished.");
	return manual.remainingDownloads > 0
		? `${done} ${t("{count} batches are still waiting for files and keep retrying.", { count: manual.remainingDownloads })}`
		: done;
}

export function SyncPage() {
	const status = useStore((s) => s.syncStatus);
	const [busy, setBusy] = useState("");
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [deviceName, setDeviceName] = useState("");
	const [clientTouched, setClientTouched] = useState(false);
	const [deviceTouched, setDeviceTouched] = useState(false);

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

	const badge = connectionBadge(status);
	const folder = status.folder;
	const account = status.account;
	const risk = status.externalRisk ?? { detected: false };
	const pendingBindings = status.pendingBindings ?? [];
	const conflicts = status.conflicts ?? [];

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
		try {
			const picked = await post("/api/fs/pick-folder", { title: t("Choose this workspace's folder") });
			if (picked?.path) {
				const result = await post("/api/sync/bind", { workspaceId, rootPath: picked.path });
				if (result?.status) set({ syncStatus: result.status });
				toast(t("Workspace folder bound."), "success");
			}
		} catch (error) {
			toast(error?.message || t("The operation failed."), "error", 7000);
		} finally {
			setBusy("");
		}
	};

	return html`
		${risk.detected ? html`<div class="notice danger">${t(risk.message ?? "The operation failed.")}</div>` : null}
		<${Card}
			title=${t("Google Drive")}
			description=${t("Chats, memories and attachments sync through MyHarness's own folder in your Drive.")}
			action=${html`<span class=${`badge ${badge.cls}`}>${badge.text}</span>`}
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
						<a class="btn" href=${folder.url} target="_blank" rel="noreferrer"><${Icon} name="drive" size=${14} />${folder.name}</a>
					<//>`
				: null}
			<${Row}
				label=${t("OAuth client id")}
				description=${t("Create a Desktop app OAuth client in Google Cloud, then paste its client id here. The secret is optional.")}
				stack=${true}
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
				stack=${true}
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
			<${Row} label=${t("Waiting to upload")} description=${t("Changes already saved on this computer.")}>
				<span class="mono">${status.pendingUploads} · ${formatBytes(status.pendingBytes)}</span>
			<//>
			<${Row} label=${t("Waiting to download")} description=${t("Batches not applied yet; an object still in transit shows a download and never pretends a file is ready.")}>
				<span class="mono">${status.pendingDownloads}</span>
			<//>
			<${Row} label=${t("Last check")} description=${t("When this computer last talked to Drive.")}>
				<span class="dim">${timeText(status.lastCheckAt)}</span>
			<//>
			<${Row} label=${t("Last upload")} description=${t("Uploaded is not the same as received by another computer.")}>
				<span class="dim">${timeText(status.lastUploadAt)}</span>
			<//>
			<${Row} label=${t("Last download")} description=${t("When another computer's changes were applied here.")}>
				<span class="dim">${timeText(status.lastDownloadAt)}</span>
			<//>
			${status.lastError ? html`<div class="notice danger">${t(status.lastError)}</div>` : null}
			${(status.issues ?? []).length > 0
				? html`<div class="notice warn sync-list">
						<strong>${t("Some changes are waiting for a manual look")}</strong>
						${(status.issues ?? []).slice(-5).map((issue) => html`<div key=${issue.key} class="dim">${issue.detail || issue.reason}</div>`)}
					</div>`
				: null}
			<div class="row sync-foot">
				<button class="btn" disabled=${!status.connected || busy === "check"} onClick=${() => run("check", () => post("/api/sync/check"))}>
					<${Icon} name="refresh" size=${14} />${t("Check now")}
				</button>
				<button class="btn" disabled=${manualBlocked || busy === "download"} title=${status.paused ? t("Sync is paused. Turn Pause off first.") : ""} onClick=${() => run("download", () => post("/api/sync/download"))}>
					<${Icon} name="download" size=${14} />${t("Download now")}
				</button>
				<button class="btn" disabled=${manualBlocked || busy === "sync"} title=${status.paused ? t("Sync is paused. Turn Pause off first.") : ""} onClick=${() => run("sync", () => post("/api/sync/sync"))}>
					<${Icon} name="drive" size=${14} />${t("Sync now")}
				</button>
				${manual
					? html`<span class=${`row grow ${manual.state === "failed" ? "c-danger" : "dim"}`} role="status" title=${manualText(manual, status)}>
							${manual.state === "running" ? html`<${Spinner} />` : null}<span class="truncate">${manualText(manual, status)}</span>
						</span>`
					: html`<span class="dim grow">${t("Everything also runs by itself; this button is for troubleshooting.")}</span>`}
			</div>
		<//>
		${pendingBindings.length
			? html`<${Card} title=${t("Workspaces restored to a managed folder")} description=${t("Pick the folder this computer should use. Chats and memories already work; file tools wait for the binding.")}>
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
			? html`<${Card} title=${t("Kept for review")} description=${t("Nothing was overwritten. The local version is in use; the other version is saved beside the agent data.")}>
					${conflicts.slice(0, 20).map(
						(conflict) => html`<div class="set-row stack" key=${conflict.id}>
							<div class="set-text"><span class="set-label">${conflict.key}</span><span class="set-desc">${t(conflict.message)}</span></div>
							<div class="set-control sync-paths">
								<span class="dim mono truncate" title=${conflict.localPath || ""}>${conflict.localPath || ""}</span>
								${conflict.remoteCopyPath ? html`<span class="dim mono truncate" title=${conflict.remoteCopyPath}>${conflict.remoteCopyPath}</span>` : null}
								<span class="dim">${conflict.deviceName} · ${timeText(conflict.at)}</span>
							</div>
						</div>`,
					)}
				<//>`
			: null}
		<${Card} title=${t("What syncs")} description=${t("Scanned by meaning, never by copying the whole Data folder.")}>
			<div class="set-desc sync-list">
				<div>${t("All memories: global, workspace, session, archived, pending and the profile.")}</div>
				<div>${t("General mode: workspaces, chats and branches, attachments, artifacts, library files, drafts and the general personal prompt.")}</div>
				<div>${t("Coding-mode chats and repositories are not uploaded; their memories are.")}</div>
				<div>${t("API keys, Google tokens, trust decisions, locks and running tasks never leave this computer.")}</div>
				<div>${t("The Google token is kept in an owner-only file (Windows user permissions). It is not OS-encrypted or end-to-end encrypted.")}</div>
			</div>
		<//>`;
}
