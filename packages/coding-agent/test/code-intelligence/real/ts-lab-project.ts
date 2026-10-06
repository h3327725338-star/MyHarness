import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Isolated TypeScript sample project used by real language-server and changeset tests.
 * It is generated into a temporary directory; nothing here ever points at user sources.
 *
 * The layout deliberately contains the shapes the symbols tooling must get right:
 * export class/function declarations, abstract + interface hierarchies, overloads,
 * a decorator with the same name as a symbol, string-literal and computed method names,
 * re-exports with aliases, an anonymous default export, non-BMP text, CRLF, and a
 * second sub-project with its own tsconfig.
 */
export const TS_LAB_FILES: Readonly<Record<string, string>> = {
	"package.json": JSON.stringify({ name: "ts-lab", private: true, version: "1.0.0", type: "module" }, null, 2),
	"tsconfig.json": JSON.stringify(
		{
			compilerOptions: {
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "Bundler",
				strict: true,
				noEmit: true,
				skipLibCheck: true,
				experimentalDecorators: true,
			},
			include: ["src"],
		},
		null,
		2,
	),
	"src/shapes.ts": [
		"export interface Shape {",
		"\tarea(): number;",
		"\treadonly label: string;",
		"}",
		"",
		"export abstract class BaseShape implements Shape {",
		"\tabstract area(): number;",
		"\tget label(): string {",
		'\t\treturn "shape";',
		"\t}",
		"\tdescribe(): string {",
		"\t\treturn [this.label, this.area()].join(':');",
		"\t}",
		"}",
		"",
		"export class Circle extends BaseShape {",
		"\tconstructor(private readonly radius: number) {",
		"\t\tsuper();",
		"\t}",
		"\tarea(): number {",
		"\t\treturn Math.PI * this.radius * this.radius;",
		"\t}",
		"}",
		"",
		"export class Square extends BaseShape {",
		"\tconstructor(private readonly side: number) {",
		"\t\tsuper();",
		"\t}",
		"\tarea(): number {",
		"\t\treturn this.side * this.side;",
		"\t}",
		"}",
		"",
		"export function totalArea(shapes: readonly Shape[]): number {",
		"\treturn shapes.reduce((sum, shape) => sum + shape.area(), 0);",
		"}",
		"",
	].join("\n"),
	"src/util.ts": [
		"export function formatArea(value: number): string {",
		"\treturn value.toFixed(2) + ' sq';",
		"}",
		"",
		"export function pick(value: string): string;",
		"export function pick(value: number): number;",
		"export function pick(value: string | number): string | number {",
		"\treturn value;",
		"}",
		"",
		"export const helper = (input: number): number => input * 2;",
		"",
	].join("\n"),
	"src/decorators.ts": [
		"function Component(options: { name: string }): ClassDecorator {",
		"\treturn () => {",
		"\t\tvoid options;",
		"\t};",
		"}",
		"",
		'@Component({ name: "Widget" })',
		"export class Widget {",
		'\t"my-method"(value: string): string {',
		"\t\treturn value;",
		"\t}",
		"\t[Symbol.iterator](): Iterator<number> {",
		"\t\treturn [1, 2, 3][Symbol.iterator]();",
		"\t}",
		"}",
		"",
	].join("\n"),
	"src/anonymous.ts": ["export default class {", "\trun(): number {", "\t\treturn 1;", "\t}", "}", ""].join("\n"),
	"src/emoji.ts": [
		"// 😀😀 comment with emoji before the declaration",
		"export const note = '😀'; export class Emoji {",
		"\tgreet(): string {",
		'\t\treturn "hi 😀";',
		"\t}",
		"}",
		"",
	].join("\n"),
	"src/crlf.ts": ["export class Windows {", "\tvalue(): number {", "\t\treturn 7;", "\t}", "}", ""].join("\r\n"),
	"src/index.ts": [
		'export * from "./shapes";',
		'export { formatArea as fmt, pick } from "./util";',
		'export { Widget } from "./decorators";',
		"",
	].join("\n"),
	"src/consumer.ts": [
		'import { Circle, Square, totalArea, fmt, pick } from "./index";',
		"",
		"export function report(radius: number, side: number): string {",
		"\tconst shapes = [new Circle(radius), new Square(side)];",
		"\tconst text = fmt(totalArea(shapes));",
		"\tconst echoed = pick(text);",
		"\treturn [text, echoed].join('|');",
		"}",
		"",
		"export function describeAll(radius: number): string {",
		"\treturn new Circle(radius).describe();",
		"}",
		"",
	].join("\n"),
	"packages/b/tsconfig.json": JSON.stringify(
		{
			compilerOptions: {
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "Bundler",
				strict: true,
				noEmit: true,
			},
			include: ["src"],
		},
		null,
		2,
	),
	"packages/b/src/other.ts": ["export class Other {", "\tid(): number {", "\t\treturn 42;", "\t}", "}", ""].join("\n"),
};

export function writeTsLabProject(root: string, extra: Readonly<Record<string, string>> = {}): void {
	for (const [relativePath, content] of Object.entries({ ...TS_LAB_FILES, ...extra })) {
		const target = join(root, ...relativePath.split("/"));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content, "utf8");
	}
}
