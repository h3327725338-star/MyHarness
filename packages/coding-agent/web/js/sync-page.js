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
	// A connection that works says nothing about the files: conflicts, blocked deletions or a failed pass must not be
	// covered by a green "Syncing" badge.
	const files = status.files;
	const blocked = (files?.workspaces ?? []).some(
		(item) =>
			item.state === "blocked" || item.state === "error" || item.state === "waiting" || item.incomplete === true,
	);
	const unresolved =
		(files?.conflicts?.length ?? 0) +
		(files?.issues?.length ?? 0) +
		(status.conflicts?.length ?? 0) +
		(status.issues?.length ?? 0);
	if (status.lastError || blocked) return { cls: "warn", text: t("Needs attention") };
	if (unresolved > 0) return { cls: "warn", text: t("Has unresolved changes") };
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
	const files = status?.files;
	const pendingFiles = (files?.workspaces ?? []).reduce(
		(total, item) => total + (item.pendingUploads ?? 0) + (item.pendingDownloads ?? 0),
		0,
	);
	const unresolved =
		(files?.conflicts?.length ?? 0) +
		(files?.issues?.length ?? 0) +
		(status?.conflicts?.length ?? 0) +
		(status?.issues?.length ?? 0) +
		(files?.workspaces ?? []).filter(
			(item) => item.state === "blocked" || item.state === "error" || item.incomplete === true,
		).length;
	if ((manual.remainingDownloads ?? 0) > 0 || pendingFiles > 0 || unresolved > 0) {
		// The pass ended, but "finished" would read as "everything arrived".
		return t("The pass finished; {count} items are still waiting.", {
			count: pendingFiles + (manual.remainingDownloads ?? 0) + unresolved,
		});
	}
	const done = manual.kind === "download" ? t("Download finished.") : t("Sync finished.");
	return done;
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
	const files = status.files ?? null;
	const fileWorkspaces = files?.workspaces ?? [];
	const fileConflicts = files?.conflicts ?? [];
	// A local workspace that already got its managed copy on this device needs no restore card.
	const managedIds = new Set(fileWorkspaces.filter((item) => item.managed).map((item) => item.workspaceId));
	const pendingBindings = (status.pendingBindings ?? []).filter((item) => !managedIds.has(item.workspaceId));
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
		${fileWorkspaces.length
			? html`<${Card} title=${t("Workspace files")} description=${t("Each workspace records who syncs its files. A finished chat upload never proves that its folder is fully uploaded.")}>
					${fileWorkspaces.map(
						(item) => html`<${Row} key=${item.workspaceId} label=${item.name} description=${item.path || ""} stack=${true}>
							<div class="row sync-field">
								<span class="dim grow" role="status" title=${item.message}>${item.message}</span>
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
			? html`<${Card} title=${t("File conflicts")} description=${t("Nothing was overwritten. Choose what becomes the new version; the other computers then receive it.")}>
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
