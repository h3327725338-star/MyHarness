/**
 * Query terms for intent-based discovery.
 *
 * A request such as "normalize a Windows path to forward slashes" rarely uses
 * the identifier the existing code chose (`toPosixPath`, `slashify`, ...).
 * The terms below bridge that gap deterministically: identifiers are split
 * into words, words are reduced to a stem that also matches their inflected
 * forms, and a small table of programming synonyms adds the usual alternative
 * verbs and nouns. CJK text (comments, docs, requests written in Chinese) is
 * matched through character bigrams. No model and no network are involved, so
 * the same request over the same code always ranks the same way.
 */

export interface QueryTerm {
	/** Lower-case stem; matched as a case-insensitive prefix of a word. */
	readonly stem: string;
	/** Where the term came from: an explicit candidate name, the intent text, or a synonym of one of them. */
	readonly origin: "name" | "intent" | "synonym";
	readonly weight: number;
	/** The original word, for display. */
	readonly display: string;
}

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"any",
	"are",
	"as",
	"at",
	"be",
	"by",
	"can",
	"code",
	"do",
	"does",
	"each",
	"existing",
	"for",
	"from",
	"function",
	"get",
	"given",
	"helper",
	"if",
	"implement",
	"implementation",
	"in",
	"into",
	"is",
	"it",
	"its",
	"method",
	"new",
	"of",
	"on",
	"one",
	"or",
	"other",
	"some",
	"that",
	"the",
	"their",
	"them",
	"then",
	"this",
	"to",
	"use",
	"util",
	"utils",
	"value",
	"way",
	"when",
	"which",
	"with",
	"without",
	"whether",
	"lies",
	"something",
]);

/**
 * Groups of words that commonly name the same operation or concept in code.
 * Kept small and generic on purpose: project vocabulary comes from the code
 * itself, this only covers the usual alternative spellings.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
	["get", "fetch", "load", "read", "retrieve", "obtain", "lookup", "find", "query", "resolve"],
	["save", "store", "persist", "write", "put", "record"],
	["delete", "remove", "drop", "erase", "purge", "clear", "unlink", "dispose"],
	["create", "make", "build", "construct", "generate", "new", "init", "initialize"],
	["update", "modify", "change", "edit", "patch", "set", "apply"],
	["parse", "decode", "deserialize", "unmarshal", "read"],
	["format", "render", "stringify", "serialize", "encode", "print", "marshal"],
	["check", "validate", "verify", "assert", "ensure", "guard", "test"],
	["normalize", "canonical", "canonicalize", "sanitize", "clean", "standardize"],
	["convert", "transform", "map", "translate"],
	["split", "tokenize", "chunk", "segment", "partition"],
	["join", "merge", "combine", "concat", "concatenate"],
	["compare", "diff", "equal", "equals", "match", "same"],
	["copy", "clone", "duplicate"],
	["send", "post", "emit", "dispatch", "publish", "notify"],
	["receive", "listen", "subscribe", "handle"],
	["start", "launch", "spawn", "run", "execute", "exec", "invoke", "begin"],
	["stop", "kill", "terminate", "cancel", "abort", "shutdown", "end"],
	["retry", "backoff", "attempt", "repeat"],
	["cache", "memo", "memoize", "memoise"],
	["config", "configuration", "settings", "options", "preferences", "prefs"],
	["path", "file", "filename", "filepath", "dir", "directory", "folder"],
	["slash", "slashes", "separator", "sep", "posix", "backslash"],
	["error", "exception", "failure", "fault"],
	["log", "logger", "trace", "debug"],
	["user", "account", "member", "profile"],
	["auth", "authenticate", "authentication", "login", "signin", "credential", "token"],
	["hash", "digest", "checksum", "sha", "fingerprint"],
	["time", "date", "timestamp", "clock", "duration"],
	["count", "size", "length", "total", "number"],
	["list", "array", "items", "collection", "entries"],
	["sort", "order", "rank"],
	["filter", "select", "exclude", "include", "where"],
	["truncate", "clip", "trim", "shorten", "limit", "cap"],
	["escape", "quote", "unescape"],
	["url", "uri", "link", "href"],
	["http", "request", "fetch", "client"],
	["json", "yaml", "toml", "xml"],
	["env", "environment", "variable"],
	["lock", "mutex", "queue", "serialize"],
	["temp", "tmp", "temporary", "scratch"],
	["unique", "dedupe", "dedup", "distinct"],
	["exists", "exist", "present", "has", "contains"],
	["watch", "observe", "monitor"],
];

/** Chinese words that often appear in requests, mapped to the English vocabulary used in code. */
const CJK_GLOSSARY: ReadonlyArray<readonly [string, readonly string[]]> = [
	["读取", ["read", "load"]],
	["加载", ["load"]],
	["获取", ["get", "fetch"]],
	["保存", ["save", "store"]],
	["写入", ["write"]],
	["删除", ["delete", "remove"]],
	["创建", ["create"]],
	["更新", ["update"]],
	["解析", ["parse"]],
	["格式化", ["format"]],
	["校验", ["validate", "check"]],
	["验证", ["validate", "verify"]],
	["检查", ["check"]],
	["规范化", ["normalize"]],
	["标准化", ["normalize"]],
	["转换", ["convert"]],
	["比较", ["compare"]],
	["合并", ["merge"]],
	["拆分", ["split"]],
	["复制", ["copy"]],
	["发送", ["send"]],
	["启动", ["start", "launch"]],
	["停止", ["stop"]],
	["取消", ["cancel", "abort"]],
	["重试", ["retry"]],
	["缓存", ["cache"]],
	["配置", ["config", "settings"]],
	["设置", ["settings"]],
	["路径", ["path"]],
	["文件", ["file"]],
	["目录", ["directory", "dir"]],
	["斜杠", ["slash"]],
	["反斜杠", ["backslash"]],
	["错误", ["error"]],
	["日志", ["log"]],
	["用户", ["user"]],
	["登录", ["login", "auth"]],
	["认证", ["auth"]],
	["令牌", ["token"]],
	["哈希", ["hash"]],
	["时间", ["time"]],
	["日期", ["date"]],
	["排序", ["sort"]],
	["过滤", ["filter"]],
	["截断", ["truncate"]],
	["转义", ["escape"]],
	["链接", ["url", "link"]],
	["请求", ["request"]],
	["环境变量", ["env"]],
	["锁", ["lock"]],
	["队列", ["queue"]],
	["临时", ["temp"]],
	["去重", ["dedupe", "unique"]],
	["存在", ["exists"]],
	["监听", ["watch", "listen"]],
	["进程", ["process"]],
	["命令", ["command"]],
	["字符串", ["string"]],
	["数组", ["array", "list"]],
	["列表", ["list"]],
	["编码", ["encode"]],
	["解码", ["decode"]],
	["序列化", ["serialize"]],
	["工作区", ["workspace"]],
	["会话", ["session"]],
	["模型", ["model"]],
	["工具", ["tool"]],
	["原子", ["atomic"]],
	["磁盘", ["disk", "file"]],
	["失败", ["fail", "error"]],
	["替换", ["replace"]],
	["重命名", ["rename"]],
	["内部", ["inside", "within"]],
	["里面", ["inside"]],
	["之内", ["inside", "within"]],
	["包含", ["contains", "inside"]],
	["持久化", ["persist"]],
	["恢复", ["restore", "recover"]],
	["回滚", ["rollback", "restore"]],
	["超时", ["timeout"]],
	["并发", ["concurrency", "parallel"]],
	["分页", ["page", "paginate"]],
	["上传", ["upload"]],
	["下载", ["download"]],
	["压缩", ["compress", "zip"]],
	["解压", ["extract", "unzip"]],
	["匹配", ["match"]],
	["搜索", ["search"]],
	["查找", ["find", "search"]],
	["通知", ["notify", "notification"]],
	["权限", ["permission"]],
	["签名", ["signature"]],
];

const SUFFIXES = [
	"ations",
	"ation",
	"izing",
	"ising",
	"ized",
	"ised",
	"izes",
	"ises",
	"ings",
	"ing",
	"ers",
	"er",
	"ies",
	"es",
	"ed",
	"s",
];

/** Light English stemmer: enough for prefix matching of inflected forms, not linguistics. */
export function stemWord(word: string): string {
	const lower = word.toLowerCase();
	for (const suffix of SUFFIXES) {
		if (lower.length - suffix.length >= 4 && lower.endsWith(suffix)) {
			const base = lower.slice(0, -suffix.length);
			return suffix === "ies" ? `${base}y` : base;
		}
	}
	if (lower.length > 4 && lower.endsWith("e")) return lower.slice(0, -1);
	return lower;
}

/** Split identifiers and prose into lower-case words: `toPosixPath` -> to, posix, path. */
export function splitWords(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.map((word) => word.toLowerCase())
		.filter((word) => word.length > 0 && !/^\d+$/.test(word));
}

const CJK_RUN = /[㐀-鿿豈-﫿]+/g;

function cjkBigrams(text: string): string[] {
	const grams: string[] = [];
	for (const match of text.matchAll(CJK_RUN)) {
		const run = match[0];
		if (run.length <= 2) {
			grams.push(run);
			continue;
		}
		for (let index = 0; index + 2 <= run.length; index++) grams.push(run.slice(index, index + 2));
	}
	return grams;
}

const synonymIndex = new Map<string, Set<string>>();
for (const group of SYNONYM_GROUPS) {
	for (const word of group) {
		const stem = stemWord(word);
		let set = synonymIndex.get(stem);
		if (!set) {
			set = new Set();
			synonymIndex.set(stem, set);
		}
		for (const other of group) if (other !== word) set.add(stemWord(other));
	}
}

function synonymsOf(stem: string): string[] {
	return [...(synonymIndex.get(stem) ?? [])].filter((candidate) => candidate !== stem);
}

/**
 * Build the weighted terms of a discovery query. Explicit candidate names
 * weigh most, intent words next, synonyms least. A stem keeps its strongest
 * origin when it is produced more than once.
 */
export function buildQueryTerms(intent: string, names: readonly string[]): QueryTerm[] {
	const terms = new Map<string, QueryTerm>();
	const add = (stem: string, origin: QueryTerm["origin"], weight: number, display: string): void => {
		if (stem.length < 2) return;
		const existing = terms.get(stem);
		if (!existing || existing.weight < weight) terms.set(stem, { stem, origin, weight, display });
	};
	const addWord = (word: string, origin: "name" | "intent", weight: number): void => {
		if (origin === "intent" && (STOP_WORDS.has(word) || word.length < 3)) return;
		if (origin === "name" && word.length < 2) return;
		const stem = stemWord(word);
		add(stem, origin, weight, word);
		for (const synonym of synonymsOf(stem)) add(synonym, "synonym", weight * 0.45, synonym);
	};
	for (const name of names) for (const word of splitWords(name)) addWord(word, "name", 1.5);
	for (const word of splitWords(intent)) addWord(word, "intent", 1);
	for (const [phrase, english] of CJK_GLOSSARY) {
		if (!intent.includes(phrase)) continue;
		for (const word of english) addWord(word, "intent", 0.9);
	}
	for (const gram of cjkBigrams(intent)) add(gram, "intent", 0.7, gram);
	return [...terms.values()].sort((left, right) => right.weight - left.weight || left.stem.localeCompare(right.stem));
}

export function isCjkTerm(term: QueryTerm): boolean {
	return /[㐀-鿿豈-﫿]/.test(term.stem);
}

/**
 * A short stem ("to", "id", "url") must be the whole word; a longer stem
 * matches the words it starts (normaliz -> normalized, normalization), and a
 * word of four or more letters also matches a longer stem it starts (norm).
 */
export function wordMatchesStem(word: string, stem: string): boolean {
	if (stem.length < 4) return word === stem || stemWord(word) === stem;
	return word.startsWith(stem) || (word.length >= 4 && stem.startsWith(word));
}

/** Which terms a piece of text contains (word-prefix match for Latin stems, substring for CJK). */
export function matchTerms(text: string, terms: readonly QueryTerm[]): QueryTerm[] {
	if (text === "") return [];
	const words = splitWords(text);
	const matched = new Set<QueryTerm>();
	for (const term of terms) if (isCjkTerm(term) && text.includes(term.stem)) matched.add(term);
	// One word counts for one term: "file" must not also count as the synonyms
	// "filename" and "filepath" it happens to start. The best-weighted match
	// wins, an exact stem before a prefix.
	for (const word of words) {
		let best: QueryTerm | undefined;
		let bestExact = false;
		for (const term of terms) {
			if (isCjkTerm(term) || !wordMatchesStem(word, term.stem)) continue;
			const exact = word === term.stem || stemWord(word) === term.stem;
			if (!best || (exact && !bestExact) || (exact === bestExact && term.weight > best.weight)) {
				best = term;
				bestExact = exact;
			}
		}
		if (best) matched.add(best);
	}
	return terms.filter((term) => matched.has(term));
}
