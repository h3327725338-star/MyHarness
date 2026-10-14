import { readFile } from "node:fs/promises";

/** Bounded, read-only MS-CFB stream reader. No files are created beside the source. */
export function compoundStreams(bytes: Buffer): Map<string, Buffer> {
	if (bytes.length < 512 || bytes.subarray(0, 8).toString("hex") !== "d0cf11e0a1b11ae1")
		throw new Error("不是有效的 Office 复合文档");
	const shift = bytes.readUInt16LE(30);
	if (![9, 12].includes(shift) || bytes.readUInt16LE(32) !== 6) throw new Error("无效的复合文档扇区");
	const sectorSize = 2 ** shift;
	const max = Math.floor(bytes.length / sectorSize);
	const sector = (id: number) => {
		if (id >= max - 1) throw new Error("复合文档扇区越界");
		return bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);
	};
	const difat: number[] = [];
	for (let i = 0; i < 109; i++) {
		const id = bytes.readUInt32LE(76 + i * 4);
		if (id < 0xfffffffa) difat.push(id);
	}
	let next = bytes.readUInt32LE(68);
	const seen = new Set<number>();
	while (next < 0xfffffffa) {
		if (seen.has(next) || seen.size >= max) throw new Error("复合文档链循环");
		seen.add(next);
		const block = sector(next);
		for (let i = 0; i < sectorSize - 4; i += 4) {
			const id = block.readUInt32LE(i);
			if (id < 0xfffffffa) difat.push(id);
		}
		next = block.readUInt32LE(sectorSize - 4);
	}
	const fat = Buffer.concat(difat.map(sector));
	const chain = (start: number, table: Buffer, get: (id: number) => Buffer, bound: number): Buffer => {
		const visited = new Set<number>();
		const blocks: Buffer[] = [];
		let id = start;
		while (id < 0xfffffffa) {
			if (visited.has(id) || visited.size >= bound || id * 4 + 4 > table.length) throw new Error("复合文档链损坏");
			visited.add(id);
			blocks.push(get(id));
			id = table.readUInt32LE(id * 4);
		}
		return Buffer.concat(blocks);
	};
	const directory = chain(bytes.readUInt32LE(48), fat, sector, max);
	const entries: { name: string; type: number; start: number; size: number }[] = [];
	for (let off = 0; off + 128 <= directory.length; off += 128) {
		const length = directory.readUInt16LE(off + 64);
		if (length > 64 || length % 2) throw new Error("复合文档目录损坏");
		entries.push({
			name: directory.subarray(off, off + Math.max(0, length - 2)).toString("utf16le"),
			type: directory[off + 66]!,
			start: directory.readUInt32LE(off + 116),
			size: directory.readUInt32LE(off + 120),
		});
	}
	const root = entries.find((entry) => entry.type === 5);
	if (!root) throw new Error("复合文档缺少根目录");
	const mini = chain(root.start, fat, sector, max).subarray(0, root.size);
	const miniFat = chain(bytes.readUInt32LE(60), fat, sector, max);
	const streams = new Map<string, Buffer>();
	let extractedBytes = 0;
	for (const entry of entries.filter((entry) => entry.type === 2)) {
		if (entry.size > bytes.length) throw new Error("复合文档流长度越界");
		const data =
			entry.size < bytes.readUInt32LE(56)
				? chain(
						entry.start,
						miniFat,
						(id) => {
							if (id * 64 >= mini.length) throw new Error("复合文档小扇区越界");
							return mini.subarray(id * 64, (id + 1) * 64);
						},
						Math.ceil(mini.length / 64),
					)
				: chain(entry.start, fat, sector, max);
		extractedBytes += data.length;
		if (extractedBytes > bytes.length * 2) throw new Error("复合文档流总量超过安全上限");
		if (data.length < entry.size) throw new Error("复合文档流被截断");
		streams.set(entry.name, data.subarray(0, entry.size));
	}
	return streams;
}

export function extractPptStream(stream: Buffer): string {
	const slides: string[][] = [];
	let current: string[] | undefined;
	let records = 0;
	const walk = (start: number, end: number, depth: number): void => {
		if (depth > 64) throw new Error("PPT 嵌套超过安全上限");
		for (let off = start; off + 8 <= end; ) {
			if (++records > 1_000_000) throw new Error("PPT 记录超过安全上限");
			const options = stream.readUInt16LE(off),
				type = stream.readUInt16LE(off + 2),
				size = stream.readUInt32LE(off + 4);
			const body = off + 8,
				finish = body + size;
			if (finish > end) throw new Error("PPT 记录损坏或存在密码保护");
			if (type === 0x2f14) throw new Error("PPT 存在密码保护");
			if (type === 1006) {
				current = [];
				slides.push(current);
			}
			if ((options & 15) === 15) walk(body, finish, depth + 1);
			else if (type === 4000 || type === 4008) {
				const text = stream
					.subarray(body, finish)
					.toString(type === 4000 ? "utf16le" : "latin1")
					.replace(/\r/g, "\n")
					.replace(/\0/g, "")
					.trim();
				if (text) {
					if (!current) {
						current = [];
						slides.push(current);
					}
					current.push(text);
				}
			}
			off = finish;
		}
	};
	walk(0, stream.length, 0);
	if (!slides.some((slide) => slide.length)) throw new Error("PPT 未发现可提取的正文");
	return slides.map((slide, index) => `## 第 ${index + 1} 张幻灯片\n\n${slide.join("\n\n")}`).join("\n\n");
}

export async function extractLegacyOffice(path: string): Promise<string> {
	const streams = compoundStreams(await readFile(path));
	if (streams.has("EncryptedPackage") || streams.has("EncryptionInfo")) throw new Error("文档存在密码保护");
	const ppt = streams.get("PowerPoint Document");
	if (ppt) return extractPptStream(ppt);
	throw new Error("当前解析器尚不能可靠提取此旧版 DOC/XLS 文档，请另存为 DOCX/XLSX 后读取");
}
