import { randomUUID } from "node:crypto";
import type { SymbolsToolDetails, SymbolsToolInput } from "./symbols.ts";

interface Snapshot {
	readonly key: string;
	readonly entries: readonly string[];
	readonly header: readonly string[];
	readonly details: SymbolsToolDetails;
	readonly createdAt: number;
	readonly chars: number;
}
const MAX_SNAPSHOTS = 8;
const MAX_SNAPSHOT_CHARS = 8_000_000;
const MAX_AGE_MS = 5 * 60_000;
const COORDINATES =
	"[coordinates] lines=1-based; positions=0-based UTF-16; symbolId coordinates=0-based (opaque, do not infer display lines)";

/** Tool-local, bounded snapshots: continuation never reruns an expensive LSP query. */
export class SymbolsOutputPages {
	private readonly snapshots = new Map<string, Snapshot>();

	private key(args: SymbolsToolInput): string {
		return JSON.stringify(
			Object.entries(args)
				.filter(([key]) => key !== "cursor" && key !== "maxChars")
				.sort(([left], [right]) => left.localeCompare(right)),
		);
	}

	private prune(): void {
		for (const [id, snapshot] of this.snapshots)
			if (Date.now() - snapshot.createdAt > MAX_AGE_MS) this.snapshots.delete(id);
		let chars = [...this.snapshots.values()].reduce((sum, snapshot) => sum + snapshot.chars, 0);
		while (this.snapshots.size > MAX_SNAPSHOTS || chars > MAX_SNAPSHOT_CHARS) {
			const id = this.snapshots.keys().next().value!;
			const snapshot = this.snapshots.get(id)!;
			chars -= snapshot.chars;
			this.snapshots.delete(id);
		}
	}

	create(args: SymbolsToolInput, text: string, details: SymbolsToolDetails, maxChars: number) {
		const id = randomUUID();
		const lines = text.split("\n");
		const header: string[] = [];
		// Metadata/warnings are repeated across pages; source entries are never sliced.
		while (
			lines[0]?.startsWith("[source=") ||
			lines[0]?.startsWith("[warning]") ||
			lines[0]?.startsWith("[fallback]")
		)
			header.push(lines.shift()!);
		const entries: string[] = [];
		for (const line of lines) {
			if (
				(/^\s+call_site\s/.test(line) || (args.operation === "find_existing" && /^\s{3}/.test(line))) &&
				entries.length
			)
				entries[entries.length - 1] += `\n${line}`;
			else entries.push(line);
		}
		const snapshot: Snapshot = {
			key: this.key(args),
			entries,
			header,
			details: { ...details },
			createdAt: Date.now(),
			chars: text.length + JSON.stringify(details).length + this.key(args).length,
		};
		if (snapshot.chars > MAX_SNAPSHOT_CHARS) {
			return this.page(id, snapshot, 0, maxChars, true);
		}
		this.snapshots.set(id, snapshot);
		this.prune();
		const page = this.page(id, snapshot, 0, maxChars);
		if (!page.details.nextCursor) this.snapshots.delete(id);
		return page;
	}

	continue(args: SymbolsToolInput, cursor: string, maxChars: number) {
		this.prune();
		const match = /^([a-f0-9-]+):(\d+)$/i.exec(cursor);
		const snapshot = match ? this.snapshots.get(match[1]) : undefined;
		if (!snapshot || snapshot.key !== this.key(args))
			throw new Error(
				"cursor is expired, unknown, or belongs to another query/tool instance; repeat the original query without cursor",
			);
		const offset = Number(match![2]);
		if (!Number.isSafeInteger(offset) || offset < 0 || offset >= snapshot.entries.length)
			throw new Error("invalid cursor offset; repeat the original query without cursor");
		return this.page(match![1], snapshot, offset, maxChars);
	}

	private page(id: string, snapshot: Snapshot, offset: number, maxChars: number, uncached = false) {
		const details: SymbolsToolDetails = {
			...snapshot.details,
			offset,
			totalEntries: snapshot.entries.length,
			queryCompleteness: snapshot.details.completeness ?? "complete",
		};
		let header = [...snapshot.header, COORDINATES];
		if (header.join("\n").length > maxChars / 2) {
			header = [
				snapshot.header[0]?.length && snapshot.header[0].length < 160
					? snapshot.header[0]
					: `[source=${details.source ?? "semantic"} completeness=${details.completeness ?? "partial"}]`,
				`[warning] ${snapshot.header.length - 1} metadata/warning line(s) exceed this page budget; increase maxChars to inspect the full warnings. See structured details.warnings.`,
				COORDINATES,
			];
		}
		const output: string[] = [];
		const footerReserve = uncached ? 500 : 350;
		let size = header.join("\n").length + 1;
		let next = offset;
		while (next < snapshot.entries.length) {
			const entry = snapshot.entries[next]!;
			if (size + entry.length + 1 > maxChars - footerReserve) break;
			output.push(entry);
			size += entry.length + 1;
			next++;
		}
		const truncated = next < snapshot.entries.length;

		details.outputTruncated = truncated;
		if (truncated) {
			details.completeness = "partial";
			details.status = "partial";
			details.nextCursor = `${id}:${next}`;
			if (header[0]?.startsWith("[source="))
				header[0] = header[0].replace("completeness=complete", "completeness=partial");
			output.push(`Tool output truncated for presentation. nextCursor=${details.nextCursor}`);
			if (next === offset) {
				const rawLocation = snapshot.entries[next]?.match(/(?:^|\s)([^\s]+:\d+(?::\d+)?)/)?.[1];
				const location = rawLocation && rawLocation.length <= 160 ? rawLocation : undefined;
				output.push(
					`One complete entry exceeds this page budget (${snapshot.entries[next]!.length} characters)${location ? ` at ${location}` : ""}; increase maxChars or use read_symbol/read for its source.`,
				);
				if (snapshot.entries[next]!.length > 99_000) {
					delete details.nextCursor;
					output[output.length - 2] =
						"Tool output truncated: a complete entry exceeds the maximum page budget; narrow the query or inspect its source. No continuation is available.";
				}
			}
		}
		if (uncached) {
			delete details.nextCursor;
			const index = output.findIndex((line) => line.startsWith("Tool output truncated for presentation."));
			if (index >= 0) output[index] = "Tool output truncated for presentation.";
			output.push(
				"[warning] Result exceeds the 8M-character snapshot budget; continuation is unavailable. Narrow path/query or lower limit; do not infer absence.",
			);
		}
		return { text: [...header, ...output].join("\n"), details };
	}
}
