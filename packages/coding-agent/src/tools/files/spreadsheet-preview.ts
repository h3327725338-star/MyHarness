import type { OfficeContentNode } from "officeparser";

const MAX_ROWS = 100;
const MAX_COLUMNS = 30;
const MAX_CELL_CHARS = 500;

/** Bound the model preview without expanding sparse row/column indexes. */
export function formatSpreadsheet(content: OfficeContentNode[]): string {
	const sheets = content.some((node) => node.type === "sheet")
		? content.filter((node) => node.type === "sheet")
		: [{ type: "sheet", children: content, metadata: { sheetName: "CSV" } } as OfficeContentNode];
	const sections: string[] = [];
	const names: string[] = [];
	for (const [index, sheet] of sheets.entries()) {
		const name =
			sheet.metadata && "sheetName" in sheet.metadata ? String(sheet.metadata.sheetName) : `Sheet ${index + 1}`;
		names.push(name);
		const cells = new Map<number, Map<number, string>>();
		let rows = 0,
			columns = 0,
			fallbackRow = 0;
		const text = (node: OfficeContentNode): string => node.text ?? (node.children ?? []).map(text).join(" ");
		const walk = (nodes: OfficeContentNode[], row?: number): void => {
			let fallbackCol = 0;
			for (const node of nodes) {
				if (node.type === "row") {
					walk(node.children ?? [], fallbackRow++);
					continue;
				}
				if (node.type === "cell") {
					const metadata = node.metadata;
					const r = metadata && "row" in metadata ? Number(metadata.row) : (row ?? 0);
					const c = metadata && "col" in metadata ? Number(metadata.col) : fallbackCol++;
					if (!Number.isSafeInteger(r) || !Number.isSafeInteger(c) || r < 0 || c < 0) continue;
					rows = Math.max(rows, r + 1);
					columns = Math.max(columns, c + 1);
					if (r < MAX_ROWS && c < MAX_COLUMNS) {
						if (!cells.has(r)) cells.set(r, new Map());
						cells
							.get(r)!
							.set(c, text(node).slice(0, MAX_CELL_CHARS).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>"));
					}
				} else walk(node.children ?? [], row);
			}
		};
		walk(sheet.children ?? []);
		const width = Math.min(columns, MAX_COLUMNS);
		const lines = [
			`## 工作表 ${name}`,
			`总行数：${rows}；总列数：${columns}。预览最多 ${MAX_ROWS} 行、${MAX_COLUMNS} 列，每格最多 ${MAX_CELL_CHARS} 字符。`,
		];
		if (rows && width) {
			const render = (r: number) =>
				`| ${Array.from({ length: width }, (_, c) => cells.get(r)?.get(c) ?? "").join(" | ")} |`;
			lines.push(render(0), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
			for (let r = 1; r < Math.min(rows, MAX_ROWS); r++) lines.push(render(r));
			if (rows > MAX_ROWS || columns > MAX_COLUMNS) lines.push("[表格预览已截断；未显示的单元格仍保留在原文件中。]");
		}
		sections.push(lines.join("\n"));
	}
	return `工作表概览（${names.length}）：${names.join("、")}\n\n${sections.join("\n\n")}`;
}
