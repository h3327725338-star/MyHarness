/**
 * W171-S2: the sanitizeDetails fast path must be byte-for-byte identical to the slow path it short-circuits.
 *
 * The legacy reference below is a verbatim copy of sanitizeDetails as it existed before the fast-path change
 * (packages/coding-agent/src/modes/web/wire.ts). Every case asserts `JSON.stringify(new) === JSON.stringify(legacy)`.
 *
 * Reference-identity note: the fast path may return the input object itself instead of a JSON round-trip copy.
 * That is safe because every caller only stores the result into a freshly built wire item and never mutates it in
 * place — the wire.ts call sites (messageToWire toolResult/custom, entriesToWire gitStatus/custom/custom_message/
 * compaction/branch_summary) and host.ts (sanitizeDetails at 763/861/971) assign it to new objects, and browser
 * consumers receive their own JSON.parse copies over HTTP. The identity assertions below pin that contract.
 */

import { describe, expect, it } from "vitest";
import { sanitizeDetails } from "../src/modes/web/wire.ts";

/** Verbatim pre-fast-path implementation, kept here as the parity reference. Do not "fix" it. */
function sanitizeDetailsLegacy(details: unknown, charLimit: number = 400_000): unknown {
	if (details === undefined || details === null) return undefined;
	try {
		const text = JSON.stringify(details);
		if (text.length > charLimit) {
			return { truncatedDetails: true, originalChars: text.length };
		}
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function parity(input: unknown, charLimit?: number): void {
	const legacy = sanitizeDetailsLegacy(input, charLimit);
	const current = charLimit === undefined ? sanitizeDetails(input) : sanitizeDetails(input, charLimit);
	// Byte-for-byte output equality is the ticket's contract; stringify also distinguishes -0/NaN/Date forms.
	expect(JSON.stringify(current)).toBe(JSON.stringify(legacy));
}

function nestedObject(depth: number): Record<string, unknown> {
	const leaf: Record<string, unknown> = { end: true };
	let cur = leaf;
	for (let i = 0; i < depth; i += 1) {
		const next: Record<string, unknown> = { n: i, child: cur };
		cur = next;
	}
	return cur;
}

describe("sanitizeDetails fast-path parity (W171-S2)", () => {
	it("matches the legacy output on empty and small objects", () => {
		parity({});
		parity([]);
		parity({ a: 1, b: "hi", c: true, d: null });
		parity({ files: [{ path: "a.ts", additions: 2, deletions: 0 }], runId: 7 });
		parity({ nested: { deep: { deeper: [1, 2, { x: "y" }] } } });
	});

	it("matches the legacy output on top-level primitives and non-JSON-friendly values", () => {
		parity(undefined);
		parity(null);
		parity("text");
		parity("");
		parity(42);
		parity(-0);
		parity(NaN);
		parity(Infinity);
		parity(true);
		parity(1e21);
		parity({ u: undefined, f: () => 1, d: new Date(0) });
		parity([undefined, 1]);
		parity(new Date(0));
		parity(() => 1);
		parity(Symbol("s"));
	});

	it("matches the legacy output on objects nested deep", () => {
		parity(nestedObject(100));
		parity(nestedObject(1000));
	});

	it("matches the legacy output exactly at the default truncation threshold", () => {
		// JSON.stringify({ v: "x".repeat(n) }) is n + 7 chars: 399_993 lands on exactly 400_000 (kept),
		// 399_994 crosses it (truncated marker with the exact originalChars).
		parity({ v: "x".repeat(399_993) });
		parity({ v: "x".repeat(399_994) });
		parity("x".repeat(400_000));
		parity({ big: "x".repeat(500_000) });
	});

	it("matches the legacy output just above and below the 64KB fast-path cutoff", () => {
		// String upper bound is 2 + len*6: 10_666 chars bound to 63_998 (fast path), 10_667 to 64_004 (slow path);
		// both stay far under the default charLimit, so both must keep the data (no truncation either way).
		parity({ a: "x".repeat(10_666) });
		parity({ a: "x".repeat(10_667) });
	});

	it("matches the legacy output at custom charLimit boundaries", () => {
		parity({ a: "x".repeat(90) }, 1_000);
		parity({ a: "x".repeat(164) }, 1_000); // bound 2+984+3+1=... near 1_000; exact bytes matter, legacy decides
		parity({ a: "x".repeat(995) }, 1_000); // stringify length 1_002 > 1_000 → truncated marker
		parity({ a: 1, b: 2 }, 0);
		parity("hello", 3);
		parity("hi", 3);
	});

	it("matches the legacy output on oversized arrays", () => {
		parity(new Array(2_000).fill(0));
		parity(new Array(100_001).fill(1));
		parity(new Array(600_001).fill(1)); // exceeds the charLimit → both sides must emit the same marker
	});

	it("matches the legacy output on base64 image detail fields", () => {
		parity({ mimeType: "image/png", data: "A".repeat(4_000) });
		parity({ images: [{ mimeType: "image/jpeg", data: "B".repeat(30_000) }], note: "kept below limit" });
		parity({ images: [{ mimeType: "image/png", data: "C".repeat(200_000) }] }); // under 400K: copy, not truncated
		parity({ data: "D".repeat(600_000) }); // over 400K: truncated marker
	});

	it("matches the legacy output on cyclic and non-stringifiable values", () => {
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic.self = cyclic;
		parity(cyclic);
		const arr: unknown[] = [1];
		(arr as unknown[]).push(arr);
		parity(arr);
		parity({ b: 1n });
		parity(2n);
		// A getter that throws must behave like JSON.stringify throwing (legacy → undefined).
		parity({
			get boom(): never {
				throw new Error("getter boom");
			},
		});
	});

	it("matches the legacy output on non-plain containers and odd key layouts", () => {
		parity(new Map([["a", 1]]));
		parity(new Set([1, 2]));
		parity(Object.create(null) as object);
		const nullProto = Object.create(null) as Record<string, unknown>;
		nullProto.k = "v";
		parity(nullProto);
		parity({ "2": "b", "0": "a", z: 1 });
		// Sparse array and arrays with extra own keys are normalized only by the JSON round trip.
		const sparse = new Array(2);
		sparse[1] = 1;
		parity(sparse);
		const withExtra: unknown[] = [1];
		(withExtra as unknown as Record<string, unknown>).extra = "dropped by JSON";
		parity(withExtra);
		class WithToJSON {
			toJSON() {
				return { replaced: true };
			}
		}
		parity(new WithToJSON());
		parity({ nested: new WithToJSON() });
		// Same object referenced twice (shared, not cyclic): legacy deep-copies both occurrences.
		const shared = { s: 1 };
		parity({ a: shared, b: shared });
	});

	it("matches the legacy output on strings needing JSON escaping", () => {
		parity({ q: 'quote " back\\slash \n\t', control: "\u0000\u001f", surrog: "\ud800\udfff", pairs: "😀" });
		parity({ lineSeparator: "\\u2028", paragraphSeparator: "\u2029" });
	});

	it("takes the fast path for small plain objects and the slow path for the rest", () => {
		const small = { a: 1, b: "x".repeat(4_000) };
		// Contract: eligible blocks are returned as the same reference (callers must not mutate — see file header).
		expect(sanitizeDetails(small)).toBe(small);
		const notPlain = { d: new Date(0) };
		expect(sanitizeDetails(notPlain)).not.toBe(notPlain);
		const oversized = { a: "x".repeat(10_667) };
		expect(sanitizeDetails(oversized)).not.toBe(oversized);
	});
});
