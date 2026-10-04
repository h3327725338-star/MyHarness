import type { Usage } from "@myharness/ai";

export interface Measurement {
	value: number | null;
	estimated: boolean;
}
export interface CacheMeasurements {
	input: Measurement;
	read: Measurement;
	write: Measurement;
	prompt: Measurement;
	hitRate: Measurement;
}
const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Missing buckets stay unknown. An exact total can establish prompt size without a write bucket. */
export function measureCache(usage: Usage): CacheMeasurements {
	const bucket = (key: "input" | "cacheRead" | "cacheWrite"): Measurement => ({
		value: valid(usage[key]) && (usage.reported?.[key] ?? usage[key] > 0) ? usage[key] : null,
		estimated: false,
	});
	const input = bucket("input"),
		read = bucket("cacheRead"),
		write = bucket("cacheWrite");
	const complete = [input, read, write].every((item) => item.value !== null);
	let prompt: Measurement = { value: null, estimated: false };
	if (complete) prompt = { value: input.value! + read.value! + write.value!, estimated: false };
	else if (
		usage.totalReported &&
		valid(usage.totalTokens) &&
		valid(usage.output) &&
		usage.reported?.output &&
		usage.totalTokens >= usage.output
	)
		prompt = { value: usage.totalTokens - usage.output, estimated: false };
	else {
		const known = [input, read, write].filter((item) => item.value !== null);
		if (known.length) prompt = { value: known.reduce((sum, item) => sum + item.value!, 0), estimated: true };
	}
	// A partial prompt is a lower bound, not a defensible denominator for a hit-rate guess.
	const contradictoryTotal =
		usage.totalReported &&
		valid(usage.totalTokens) &&
		valid(usage.output) &&
		usage.reported?.output &&
		(prompt.value === null || usage.totalTokens - usage.output !== prompt.value);
	const hitRate: Measurement = {
		value:
			!contradictoryTotal &&
			!prompt.estimated &&
			prompt.value !== null &&
			prompt.value > 0 &&
			read.value !== null &&
			read.value <= prompt.value
				? read.value / prompt.value
				: null,
		estimated: false,
	};
	return { input, read, write, prompt, hitRate };
}

/** Aggregate only paired known numerators/denominators; disclose missing requests as approximate coverage. */
export function sumCache(samples: CacheMeasurements[]): CacheMeasurements {
	const sum = (key: "input" | "read" | "write" | "prompt"): Measurement => {
		const known = samples.map((sample) => sample[key]).filter((item) => item.value !== null);
		return {
			value: known.length ? known.reduce((total, item) => total + item.value!, 0) : null,
			estimated: known.length !== samples.length || known.some((item) => item.estimated),
		};
	};
	const paired = samples.filter((sample) => sample.hitRate.value !== null);
	const prompt = paired.reduce((total, sample) => total + sample.prompt.value!, 0);
	return {
		input: sum("input"),
		read: sum("read"),
		write: sum("write"),
		prompt: sum("prompt"),
		hitRate: {
			value: prompt > 0 ? paired.reduce((total, sample) => total + sample.read.value!, 0) / prompt : null,
			estimated: paired.length !== samples.length || paired.some((sample) => sample.hitRate.estimated),
		},
	};
}
