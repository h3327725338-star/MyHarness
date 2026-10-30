// Builds one evaluation copy's profile: a fresh install that only has Nebius Token Factory, written the way the one-key
// setup writes it (the setup route is run once after start to give each job its model). The key comes from evaluation
// copy A, where the user put the one to use; it is copied, never printed.
// Run from C:/myharness:  node --import ./scripts/dev-fast-loader.mjs <this file> <labDir> [portalUrl]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NEBIUS_BASE_URL, NEBIUS_PROVIDER_NAME, pickNebiusModels } from '../../../myharness/packages/coding-agent/src/providers/models/nebius-preset.ts';

const [root, portal] = process.argv.slice(2);
if (!root) throw new Error('usage: setup-lab.mjs <labDir> [portalUrl]');
const agent = join(root, 'agent');
if (existsSync(join(agent, 'auth.json'))) throw new Error(`${root} already exists`);
for (const dir of [agent, join(root, 'data'), join(root, 'tmp'), join(root, 'artifacts'), join(root, 'Documents')]) mkdirSync(dir, { recursive: true });

const auth = JSON.parse(readFileSync('C:/eval/labA/agent/auth.json', 'utf8'));
if (!auth.nebius) throw new Error('no Nebius key in the MyHarness config');
writeFileSync(join(agent, 'auth.json'), `${JSON.stringify({ nebius: auth.nebius }, null, '\t')}\n`, { mode: 0o600 });

const entry = { name: NEBIUS_PROVIDER_NAME, baseUrl: NEBIUS_BASE_URL, api: 'openai-completions', models: pickNebiusModels(undefined).map((pick) => pick.model) };
writeFileSync(join(agent, 'models.json'), `${JSON.stringify({ providers: { nebius: entry } }, null, '\t')}\n`);

// The evaluation configuration: every job on an NVIDIA Nemotron model. The main chat is set here (Nemotron 3.5
// Lightning, its top level); the setup route then fills only the jobs that are still unset (sub-agents → Ultra, vision →
// Super VL, memory/compaction/schedules → Lightning, naming/translation → Ultra). No pop-up notifications: the user may be
// at this PC.
const settings = {
	defaultProvider: 'nebius',
	defaultModel: 'nvidia/Nemotron-3_5-Lightning',
	defaultThinkingLevel: 'high',
	defaultProjectTrust: 'always',
	autoMemory: { enabled: true },
	popupNotifications: { enabled: false, sound: false },
	enableInstallTelemetry: false,
};
writeFileSync(join(agent, 'settings.json'), `${JSON.stringify(settings, null, '\t')}\n`);

if (portal) {
	mkdirSync(join(agent, 'desktop-profile'), { recursive: true });
	const now = new Date().toISOString();
	writeFileSync(join(agent, 'desktop-profile', 'browser-bookmarks.json'), `${JSON.stringify({ version: 1, bookmarks: [
		{ id: 'bm-course-portal', title: 'Course Portal', url: portal, addedAt: now, note: 'My university course portal: assignment deadlines, quiz dates, course pages, files and announcements for this term.' },
	] }, null, 2)}\n`);
}
console.log(`${root} ready | models: ${entry.models.map((model) => model.id).join(', ')}`);
