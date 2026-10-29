/**
 * Selection translation (POST /api/translate): the text the user selected in a chat, a file preview or a website of the
 * built-in browser, translated by the helper model of Settings → Agent → Assistants → Translation. A one-shot request with no
 * chat history; the text is data, never instructions (see agent/runtime/selection-translation.ts).
 */

import { contentText } from "@myharness/ai";
import {
	buildTranslationPrompt,
	isShortSelection,
	MAX_TRANSLATION_CHARS,
	normalizeTranslation,
	parseTranslationReply,
	TRANSLATION_TARGETS,
	translationTarget,
} from "../../agent/runtime/selection-translation.ts";
import { readWebPrefs, systemInterfaceLanguage } from "../../config/web-prefs.ts";
import { completeWithNetworkPolicy } from "../../providers/recovery/network-retry.ts";
import { mergeProviderAttributionHeaders } from "../../providers/runtime/attribution.ts";
import { reasoningOf, resolveHelperModel } from "./helper-model.ts";
import type { WebHost } from "./host.ts";
import { HttpError, type WebHttpServer } from "./http-server.ts";

/**
 * `agentDir`: where the page keeps its preferences. A request without `uiLanguage` (a website tab of the desktop host)
 * uses the interface language saved there, or the language of Windows while none is saved (as the page does).
 */
export function registerTranslateRoutes(server: WebHttpServer, host: WebHost, agentDir: () => string): void {
	// The saved language, so a new card shows it at once instead of the interface language until the answer arrives.
	server.route("GET", "/api/translate", ({ url }) => {
		const { targetLanguage } = host.session.settingsManager.getTranslationSettings();
		const uiLanguage = url.searchParams.get("uiLanguage") || interfaceLanguage(agentDir());
		return { preference: targetLanguage, target: translationTarget(targetLanguage, uiLanguage) };
	});
	// British or American pronunciation of an English word card (used even when Windows has a voice of that accent:
	// an installed voice is much quieter than the recording). Only a short English word or phrase is sent, to Youdao's
	// dictionary voice: the same word the card already sent to the translation model.
	server.route("GET", "/api/translate/voice", async ({ url, res }) => {
		const text = (url.searchParams.get("text") ?? "").trim();
		const accent = url.searchParams.get("accent");
		if (!ENGLISH_WORD.test(text) || (accent !== "uk" && accent !== "us"))
			throw new HttpError(400, "Only an English word or a short phrase can be read aloud.");
		const source = new URL("https://dict.youdao.com/dictvoice");
		source.searchParams.set("audio", text);
		source.searchParams.set("type", accent === "uk" ? "1" : "2");
		const response = await fetch(source, { signal: AbortSignal.timeout(8000) }).catch(() => undefined);
		const type = response?.headers.get("content-type") ?? "";
		if (!response?.ok || !type.startsWith("audio/"))
			throw new HttpError(502, "The pronunciation could not be loaded.");
		const bytes = Buffer.from(await response.arrayBuffer());
		if (!bytes.length || bytes.length > MAX_VOICE_BYTES)
			throw new HttpError(502, "The pronunciation could not be loaded.");
		res.writeHead(200, {
			"content-type": type,
			"content-length": bytes.length,
			"cache-control": "private, max-age=86400",
			"x-content-type-options": "nosniff",
		});
		res.end(bytes);
	});
	server.route("POST", "/api/translate", async ({ body, res }) => {
		const payload = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
		const text = typeof payload.text === "string" ? payload.text.trim() : "";
		if (!text) throw new HttpError(400, "Select some text to translate.");
		if (text.length > MAX_TRANSLATION_CHARS)
			throw new HttpError(400, `Select at most ${MAX_TRANSLATION_CHARS} characters to translate.`);
		// A language picked in the translation card stays the user's preference (`remember`): the same setting as
		// Settings → Agent → Assistants → Translation.
		const requested = typeof payload.target === "string" ? payload.target : undefined;
		if (requested !== undefined && requested !== "auto" && !TRANSLATION_TARGETS.includes(requested))
			throw new HttpError(400, `Unknown target language: ${requested}`);
		if (requested && payload.remember === true) {
			host.session.settingsManager.setTranslationSettings({ targetLanguage: requested });
			await host.session.settingsManager.flush();
			host.broadcast("settings_changed", { id: "translation.targetLanguage" });
		}
		const settings = host.session.settingsManager.getTranslationSettings();
		const target = translationTarget(
			requested ?? settings.targetLanguage,
			typeof payload.uiLanguage === "string" ? payload.uiLanguage : interfaceLanguage(agentDir()),
		);
		const { model, thinkingLevel } = resolveHelperModel(host, settings, "Select a main Agent model first.");
		const reasoning = reasoningOf(thinkingLevel);
		const prompt = buildTranslationPrompt(text, target);
		// opencode-style providers need their session header on one-shot requests too (see the commit description).
		const sessionId = host.session.sessionId;
		const headers = mergeProviderAttributionHeaders(model, host.session.settingsManager, sessionId);
		// A closed popup (the page aborted the request) stops the model call as well.
		const controller = new AbortController();
		res.once("close", () => {
			if (!res.writableEnded) controller.abort();
		});
		const response = await completeWithNetworkPolicy({
			runtime: host.session.modelRuntime,
			settings: host.session.settingsManager,
			model,
			context: {
				systemPrompt: prompt.systemPrompt,
				messages: [{ role: "user", content: prompt.input, timestamp: Date.now() }],
			},
			options: { signal: controller.signal, ...(reasoning ? { reasoning } : {}), sessionId, headers },
		});
		if (response.stopReason === "aborted") throw new HttpError(499, "The translation was cancelled.");
		if (response.stopReason === "error") throw new HttpError(502, response.errorMessage ?? "The translation failed.");
		const reply = contentText(response.content, "\n");
		// A word or a short phrase comes back as a word card (reading, meanings by part of speech); a passage as text.
		const { translation, entry } = isShortSelection(text)
			? parseTranslationReply(reply, text)
			: { translation: normalizeTranslation(reply, text), entry: undefined };
		if (!translation) throw new HttpError(502, "The translation model returned no text.");
		return {
			translation,
			target,
			// What the card's language menu shows as chosen ("auto": the interface language).
			preference: settings.targetLanguage,
			...(entry ? { entry } : {}),
			model: `${model.provider}/${model.id}`,
		};
	});
}

/** A word or a short phrase in English letters: what a dictionary voice can read. */
const ENGLISH_WORD = /^[A-Za-z][A-Za-z' -]{0,59}$/;
const MAX_VOICE_BYTES = 1024 * 1024;

function interfaceLanguage(dir: string): string | undefined {
	const lang = readWebPrefs(dir)?.prefs.lang;
	return typeof lang === "string" ? lang : systemInterfaceLanguage();
}
