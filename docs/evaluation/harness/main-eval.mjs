// Evaluates an expression in evaluation copy A's Electron main process (inspector 9354).
// node main-eval.mjs "<expression>"
const expression = process.argv[2];
const main = (await (await fetch('http://127.0.0.1:9354/json')).json())[0];
const socket = new WebSocket(main.webSocketDebuggerUrl);
await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = fail; });
const result = await new Promise((ok) => {
	socket.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) ok(d); };
	socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
});
console.log(JSON.stringify(result.result?.exceptionDetails ? result.result.exceptionDetails.exception?.description : result.result?.result?.value));
process.exit(0);
