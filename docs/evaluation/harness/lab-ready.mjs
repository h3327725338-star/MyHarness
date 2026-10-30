// Waits for fresh evaluation copies' servers and runs the one-key Nebius setup route once on each, which gives every job
// its model the way a user's setup does. node lab-ready.mjs <port> [port...]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const port of process.argv.slice(2)) {
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; ; i++) {
		try {
			const r = await fetch(`${base}/api/slots`, { headers: { 'x-myharness-web': '1' } });
			if (r.ok) break;
		} catch {}
		if (i > 300) throw new Error(`${port} did not start`);
		await sleep(300);
	}
	const r = await fetch(`${base}/api/providers/nebius/setup`, { method: 'POST', headers: { 'x-myharness-web': '1', 'content-type': 'application/json' }, body: '{}' });
	const j = await r.json();
	console.log(port, r.status, 'assigned', (j.assigned || []).length, 'missing', JSON.stringify(j.missing), 'listError', j.listError ?? null);
}
process.exit(0);
