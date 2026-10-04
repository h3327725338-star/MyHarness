import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";

function fixture() {
	const storage = new Map<string, string>();
	const context = vm.createContext({
		sessionStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
	});
	const source = readFileSync(new URL("../web/js/restart-state.js", import.meta.url), "utf8");
	vm.runInContext(source.replace(/^export /gm, ""), context);
	return { context, storage, run: (code: string) => vm.runInContext(code, context) };
}

it("restores current and background drafts, attachments and layout once", () => {
	const fx = fixture();
	fx.run(`drafts.set('other', {text:'background',images:[]});
registerRestartDraft(()=>({sessionId:'chat',text:'中文草稿',images:[{url:'data:image/png;base64,abc',name:'image.png'},{path:'C:/uploads/doc.txt',name:'doc.txt'}]}));
saveRestartState('chat',{panelOpen:true,panelW:620});
drafts.clear();`);
	expect(fx.run("takeRestartState('chat')")).toEqual({ panelOpen: true, panelW: 620 });
	expect(fx.run("drafts.get('chat')")).toEqual({
		text: "中文草稿",
		images: [
			{ url: "data:image/png;base64,abc", name: "image.png" },
			{ path: "C:/uploads/doc.txt", name: "doc.txt" },
		],
	});
	expect(fx.run("drafts.get('other').text")).toBe("background");
	expect(fx.run("takeRestartState('chat')")).toBeNull();
	expect(fx.storage.size).toBe(0);
});

it("does not apply a handoff to the wrong session or after its expiry", () => {
	const fx = fixture();
	fx.run("saveRestartState('chat', {panelOpen:true})");
	expect(fx.run("takeRestartState('other')")).toBeNull();
	fx.run("saveRestartState('chat', {panelOpen:true})");
	const [key, raw] = [...fx.storage][0]!;
	const saved = JSON.parse(raw);
	saved.savedAt = Date.now() - 300001;
	fx.storage.set(key, JSON.stringify(saved));
	expect(fx.run("takeRestartState('chat')")).toBeNull();
});
