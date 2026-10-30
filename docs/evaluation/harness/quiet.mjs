// Waits for the eval copy's main-process inspector (9354) and, before its window first shows, makes every window
// show inactive and off screen, so starting the copy never takes the focus or flashes on screen.
// Started by video-lab2-start-quiet.sh next to the app.
const until = Date.now() + 90000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(url, expression) {
	const socket = new WebSocket(url);
	await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
	const result = await new Promise((resolve) => {
		socket.onmessage = (message) => { const data = JSON.parse(message.data); if (data.id === 1) resolve(data); };
		socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
	});
	socket.close();
	return result.result?.result?.value;
}
const PATCH = `(() => {
	const m = process.mainModule;
	if (!m) return 'early';
	const { BrowserWindow } = m.require('electron');
	const P = BrowserWindow.prototype;
	if (P.__quiet) return 'done';
	P.__quiet = true;
	const inactive = P.showInactive;
	P.showInactive = function () { try { if (this.getBounds().x > -2000) this.setPosition(-3000, 0); } catch {} return inactive.call(this); };
	P.show = P.showInactive;
	P.focus = function () {};
	P.moveTop = function () {};
	return 'patched';
})()`;
while (Date.now() < until) {
	try {
		const list = await (await fetch('http://127.0.0.1:9354/json')).json();
		const r = await evaluate(list[0].webSocketDebuggerUrl, PATCH);
		if (r === 'patched' || r === 'done') { console.log(r, new Date().toISOString()); process.exit(0); }
	} catch {}
	await sleep(30);
}
console.log('timeout');
process.exit(1);
