import { describe, expect, it } from "vitest";
import {
	buildNamePath,
	createSymbolId,
	getParentNamePath,
	normalizeSymbolPath,
	parseNamePath,
} from "../../src/symbols/symbol-identity.ts";

describe("buildNamePath", () => {
	it("joins two components with the / separator", () => {
		expect(buildNamePath(["UserService", "load"])).toBe("UserService/load");
	});

	it("supports multi-level nesting", () => {
		expect(buildNamePath(["Api", "UserService", "load"])).toBe("Api/UserService/load");
	});

	it("appends a 0-based overload index to the leaf", () => {
		expect(buildNamePath(["UserService", "load"], 0)).toBe("UserService/load[0]");
		expect(buildNamePath(["UserService", "load"], 1)).toBe("UserService/load[1]");
	});

	it("ignores empty and undefined parent components", () => {
		expect(buildNamePath(["", "load"])).toBe("load");
		expect(buildNamePath([undefined, "load"])).toBe("load");
		expect(buildNamePath([undefined])).toBe("");
	});

	it("escapes / and \\ inside component names", () => {
		expect(buildNamePath(["operator/", "run"])).toBe("operator\\//run");
		expect(buildNamePath(["a\\b", "run"])).toBe("a\\\\b/run");
	});

	it("supports non-ASCII identifiers", () => {
		expect(buildNamePath(["用户服务", "加载用户"])).toBe("用户服务/加载用户");
	});
});

describe("parseNamePath", () => {
	it("splits components on unescaped separators", () => {
		expect(parseNamePath("Api/UserService/load")).toEqual({
			components: ["Api", "UserService", "load"],
			overloadIndex: undefined,
		});
	});

	it("parses a trailing overload index", () => {
		expect(parseNamePath("UserService/load[0]")).toEqual({
			components: ["UserService", "load"],
			overloadIndex: 0,
		});
		expect(parseNamePath("UserService/load[1]")).toEqual({
			components: ["UserService", "load"],
			overloadIndex: 1,
		});
	});

	it("round-trips escaped separators", () => {
		const serialized = buildNamePath(["operator/", "a\\b", "run"], 0);
		expect(parseNamePath(serialized)).toEqual({
			components: ["operator/", "a\\b", "run"],
			overloadIndex: 0,
		});
	});

	it("does not mistake operator[] for an overload index", () => {
		expect(parseNamePath("A/operator[]")).toEqual({
			components: ["A", "operator[]"],
			overloadIndex: undefined,
		});
	});

	it("round-trips non-ASCII identifiers", () => {
		const serialized = buildNamePath(["用户服务", "加载用户"]);
		expect(parseNamePath(serialized).components).toEqual(["用户服务", "加载用户"]);
	});

	it("round-trips a single component", () => {
		expect(parseNamePath("load")).toEqual({ components: ["load"], overloadIndex: undefined });
	});
});

describe("getParentNamePath", () => {
	it("returns the parent of a nested name path", () => {
		expect(getParentNamePath("Api/UserService/load")).toBe("Api/UserService");
	});

	it("strips the overload suffix before returning the parent", () => {
		expect(getParentNamePath("UserService/load[0]")).toBe("UserService");
	});

	it("returns undefined for a root-level symbol", () => {
		expect(getParentNamePath("load")).toBeUndefined();
	});
});

describe("normalizeSymbolPath", () => {
	it("converts backslashes to forward slashes", () => {
		expect(normalizeSymbolPath("src\\a.ts")).toBe("src/a.ts");
	});

	it("strips ./ prefixes and leading slashes", () => {
		expect(normalizeSymbolPath("./src/a.ts")).toBe("src/a.ts");
		expect(normalizeSymbolPath("/src/a.ts")).toBe("src/a.ts");
	});

	it("keeps a clean relative path unchanged", () => {
		expect(normalizeSymbolPath("src/a.ts")).toBe("src/a.ts");
	});
});

describe("createSymbolId", () => {
	const input = { path: "src/service.ts", kind: "method" as const, namePath: "UserService/load", line: 4 };

	it("is deterministic for the same input", () => {
		expect(createSymbolId(input)).toBe(createSymbolId(input));
	});

	it("distinguishes same-named methods in different parents", () => {
		const a = createSymbolId({ ...input, namePath: "A/run", line: 1 });
		const b = createSymbolId({ ...input, namePath: "B/run", line: 4 });
		expect(a).not.toBe(b);
	});

	it("distinguishes the same name path in different files", () => {
		const a = createSymbolId({ ...input, path: "src/a.ts" });
		const b = createSymbolId({ ...input, path: "src/b.ts" });
		expect(a).not.toBe(b);
	});

	it("distinguishes overloads by line", () => {
		const first = createSymbolId({ ...input, namePath: "A/run[0]", line: 1 });
		const second = createSymbolId({ ...input, namePath: "A/run[1]", line: 2 });
		expect(first).not.toBe(second);
	});

	it("normalizes the path before hashing identity", () => {
		expect(createSymbolId({ ...input, path: "./src/service.ts" })).toBe(createSymbolId(input));
		expect(createSymbolId({ ...input, path: String.raw`SRC\SERVICE.TS` })).toBe(createSymbolId(input));
	});

	it("supports non-ASCII name paths", () => {
		const id = createSymbolId({ ...input, namePath: "用户服务/加载用户", line: 0 });
		expect(id).toContain("用户服务/加载用户");
	});
});
