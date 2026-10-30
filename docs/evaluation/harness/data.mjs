// The answer keys are kept gzipped on disk, so an agent under test that searches this PC cannot grep them.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
export const loadSample = (file = 'C:/eval/data/simpleqa-sample-100.json.gz') => JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
