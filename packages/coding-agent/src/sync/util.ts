import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomicallySync } from "../utils/atomic-write.ts";
import type { SyncRecord, VersionVector } from "./types.ts";

export function sha256(data: Uint8Array | string): string {
	return createHash("sha256").update(data).digest("hex");
}

export function shortHash(value: string): string {
	return sha256(value).slice(0, 12);
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function ensureDir(directory: string): void {
	mkdirSync(directory, { recursive: true });
}

export function readJsonFile<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function writeJsonFile(file: string, value: unknown): void {
	ensureDir(dirname(file));
	writeFileAtomicallySync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Owner-only write for credentials: temporary file with mode 0600, then rename. */
export function writePrivateJsonFile(file: string, value: unknown): void {
	ensureDir(dirname(file));
	const temporary = `${file}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	try {
		renameSync(temporary, file);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

export function readBytes(file: string): Uint8Array | undefined {
	try {
		return new Uint8Array(readFileSync(file));
	} catch {
		return undefined;
	}
}

export function fileExists(file: string): boolean {
	return existsSync(file);
}

export function bumpVector(vector: VersionVector, deviceId: string, by = 1): VersionVector {
	return { ...vector, [deviceId]: (vector[deviceId] ?? 0) + by };
}

/** True when `a` is at least as new as `b` on every device (a includes b's history). */
export function covers(a: VersionVector, b: VersionVector): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) if ((a[key] ?? 0) < (b[key] ?? 0)) return false;
	return true;
}

export function sameVector(a: VersionVector, b: VersionVector): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
	return true;
}

export function mergeVectors(a: VersionVector, b: VersionVector): VersionVector {
	const merged: VersionVector = { ...a };
	for (const [key, value] of Object.entries(b)) merged[key] = Math.max(merged[key] ?? 0, value);
	return merged;
}

export function recordFrom(entity: {
	key: string;
	kind: SyncRecord["kind"];
	id: string;
	hash: string;
	size: number;
	vector: VersionVector;
	updatedAt: string;
	meta?: Record<string, string>;
}): SyncRecord {
	const record: SyncRecord = {
		key: entity.key,
		kind: entity.kind,
		id: entity.id,
		hash: entity.hash,
		size: entity.size,
		vector: entity.vector,
		updatedAt: entity.updatedAt,
	};
	if (entity.meta) record.meta = entity.meta;
	return record;
}

/** Stable JSON (sorted keys) so the same draft/prompt content hashes the same on every device. */
export function stableJson(value: unknown): string {
	const walk = (input: unknown): unknown => {
		if (Array.isArray(input)) return input.map(walk);
		if (input && typeof input === "object") {
			const sorted: Record<string, unknown> = {};
			for (const key of Object.keys(input as Record<string, unknown>).sort()) {
				sorted[key] = walk((input as Record<string, unknown>)[key]);
			}
			return sorted;
		}
		return input;
	};
	return JSON.stringify(walk(value));
}

/** Content that is pure text: upload and compare without a byte-array round trip. */
export function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

export function fromUtf8(value: Uint8Array): string {
	return new TextDecoder().decode(value);
}

/** Keep a bounded list: newest entries win. */
export function capList(values: string[], limit: number): string[] {
	return values.length <= limit ? values : values.slice(values.length - limit);
}
