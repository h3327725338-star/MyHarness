// Records, in lab A's settings, the result of MyHarness's own image test run against Nemotron 3.5 Super VL (the probe
// image and prompt from src/agent/vision/capability.ts, sent with 1024 output tokens instead of 64: with 64 the model
// spends every token reasoning and returns nothing). This is what the removed terminal Settings "test" button wrote.
// Run only while lab A is stopped. node record-vision-test.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { chat } from './nebius.mjs';
const src = readFileSync('C:/myharness/packages/coding-agent/src/agent/vision/capability.ts', 'utf8');
const image = src.match(/VISION_PROBE_IMAGE =\s*"([^"]+)"/)[1];
const system = readFileSync('C:/myharness/system-prompts/common/tasks/vision-probe.md', 'utf8');
const model = 'nvidia/Nemotron-3.5-Super-VL';
const r = await chat(model, [{ role: 'system', content: system }, { role: 'user', content: [{ type: 'text', text: 'Please read this test image.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }] }], { maxTokens: 1024, retries: 1 });
const supported = /\b731\b/u.test(r.content || '') && /(?:蓝|blue)/iu.test(r.content || '');
console.log(JSON.stringify({ answer: r.content, supported }));
if (!supported) process.exit(1);
const file = 'C:/eval/labA/agent/settings.json';
const settings = JSON.parse(readFileSync(file, 'utf8'));
settings.visionCapabilityTests = { ...(settings.visionCapabilityTests || {}), [`nebius/${encodeURIComponent(model)}`]: { status: 'supported', testedAt: Date.now() } };
settings.visionAssistant = { ...(settings.visionAssistant || {}), enabled: true, provider: 'nebius', model };
writeFileSync(file, `${JSON.stringify(settings, null, '\t')}\n`);
console.log('recorded');
