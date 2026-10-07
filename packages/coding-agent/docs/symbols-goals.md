# symbols 工具：目标与期望

> 本文档描述**用户期望 symbols 达到什么效果**，以及支撑该判断的实测事实基线。
> 它不是实现方案，不是排期，不包含已批准的改动。
> 每节标明内容性质：**[用户明确表达]** / **[实测事实]** / **[分析推论]**，供讨论时区别对待。

## 1. 背景问题 [用户明确表达]

用户要解决的 not "代码搜索不够好"，而是 **agent 缺少对整个项目的持久理解**。具体失败模式：

- agent 只看当前读到的文件，于是重复实现项目里已经存在的东西；
- agent 不知道谁调用了某个函数，于是改一处坏多处；
- agent 没有"这个项目里有什么"的全局视图，于是每次都从零开始设计。

symbols 的存在意义按这四条能否兑现来判断。兑现不了，它就不该以当前形态占据默认工具位置。

## 2. 四条能力目标 [用户明确表达]

1. **跨文件理解**：理解一个文件的代码与其他文件之间的关系，而非孤立读单文件。
2. **掌握复杂关联**：一个 function / method / call 能找到"所有与它有关的地方"——引用它的文件、调用它的地方、它的实现与继承关系。
3. **跨多文件编辑**：基于 1 和 2，一次改动能正确覆盖所有该改的位置。
4. **不再反复造轮子**：动手前知道"这个能力项目里已经有了"，从而复用而非重写。

**参照标准：VSCode。** 用户在 VSCode 中体验到的"一个 function 找出所有相关文件"即为目标形态。

## 3. 已确定的决策点

| 决策 | 用户的选择 |
|---|---|
| 语言范围 | **18 种编程语言全部支持**，不只为 TS/JS 调优 |
| 定位 | **产品级**：服务所有 MyHarness 用户的项目，不是本仓库专用 |
| 精度标准 | **跨文件改名漏改一处就是 bug**（零漏改） |
| 造轮子的口径 | **意图重复**，不是结构重复 |
| 架构信念 | **底座同源**：全量提取 → 关系 → 安全改动，是同一条链的三个出口 |

### 语言数量的准确定义 [实测事实]

`packages/coding-agent/src/symbols/index/code-index.ts` 的 `LANGUAGE_BY_EXTENSION`：**30 个扩展名 → 21 种语言标签**；去掉 `json`/`xml`/`yaml` 三个数据类 = **18 种**。

## 4. 关键前提：节点与边是两种数据 [分析推论]

用户最初表述为"只要先把东西都提出来到一处地方，就能够解决…"。这个链条中间有一段是断的，且这段决定全部工作量：

| | 是什么 | 对应 VSCode 的 | 需要什么 |
|---|---|---|---|
| **节点** | 项目里声明了哪些东西 | Outline 面板 | 提取，不需要理解 |
| **边** | 声明之间怎么连 | Find All References / Call Hierarchy / Go to Implementation | **名字解析**（作用域 + 类型信息） |

- 边不是"更多的节点"。把 31,077 个符号全部提取出来，仍然不知道某一行 `handler()` 指的是哪一个 `handler`。
- **目标 1、2、3 依赖边；目标 4 主要依赖节点。**
- 目标 3 不是独立能力，是边的**应用**：VSCode 跨文件改名安全，纯粹因为 references 算得准。

## 5. 零漏改如何成立 [分析推论]

前提组合：**18 种语言（产品级）** + **漏改即 bug**。

静态解析在这个组合下无法单独承诺零漏，且不是工程量问题：

- **可达标**：Go（`go/types`）、Rust（rust-analyzer）、TS/JS（TypeScript 编译器）、Java/C#（项目能被真实构建出 classpath）、C/C++（**必须有 `compile_commands.json`**；缺失时 clangd 给出看着权威实则错误的结果）。
- **原理上达不到**：Python / Ruby / PHP。动态派发、`getattr`、猴子补丁、按字符串注册的依赖注入、装饰器改写——这些引用关系不在静态信息中。VSCode + pyright 同样漏。

因此"漏改即 bug"这条标准**已排除**"永远给一个数字、即使不保证"的表达方式（那会直接生产用户定义为 bug 的结果）。但也不应采用"无法验证就拒绝改名"（真实项目里可完整验证者是少数，会使目标 3 作废）。

**建议采用的机制**：查询永远给全量，拒绝的是"未经确认就写入"。承诺的不是"不漏"，而是"**漏的那部分一定会作为待确认项列出**"。返回结果分三档：

1. **已解析确认** — 静态能定死的；
2. **词法候选、未确认** — 出现了该名字但未解析成功；
3. **无法覆盖** — 明确声明保证不了并给出原因（语言 / 缺构建配置 / 超出索引预算）。

随后强制 agent 对第 2、3 档逐项给出处置与理由。项目已有可承载的数据形状：`src/changes/impact-plan.ts` 的 `ImpactPlan.affected[]`（`disposition` + `reason`）、`coverage: complete|partial|unknown`、以及"`coverage !== complete` 时 `limitations` 必须非空"的校验。

### 由此推出的架构约束 [分析推论]

**"底座同源"与"逐语言能力不同"必须同时成立。** 底座的数据结构要能表达"这条结论来自哪种解析后端、覆盖到什么程度"，不能所有语言共用一个"找到 N 处"。

这也重新定位了 lightweight：**它不是"降级版 LSP"，它本来就应该是三档中的第 2 档**——候选清单，而非结论清单。当前问题正是它被当成结论使用。

## 6. 意图重复：用户提出的解法 [用户明确表达]

用户设想的流程：**提取全部 → 理解代码的做法 → 比较近似功能的地方 → 核对意图是否已有实现 → 决定复用还是新写。**

### 可行性 [分析推论]

方向成立，但它不是符号查找那条路，更接近"能力清单 + 一次强制复用评审"。两个必须补的前提：

1. **意图匹配需要的不是名字，是"它做什么"。** 已有 `retry`，新写 `withBackoff`——名字不重叠时，比较只能依赖函数体、参数形状、所在路径、注释。当前符号索引**不存代码正文**（只存一行签名）。这是该方案最大的数据缺口。
2. **全量清单装不进模型上下文。** 18 种语言、3 万+ 符号不可能整体交给 agent 比较，因此需要**分层聚合与排序视图**（按 kind / 目录 / 导出与否）。当前缺失（见 §7）。

### 最低成本落地形态 [分析推论]

不需要 embedding、不需要新后端：把该循环做成**写入前的强制一步**。agent 要新增函数/类时，工具用现有词法材料（名字分词、路径、签名）返回一批"可能近似"的粗筛候选，并要求 agent 对每个候选给出处置（复用 / 改造 / 确认无关）+ 理由。粗筛不要求准，只要求**不许跳过检查**。

与已有的 `StructuralReuseGate` 正好互补：那个抓**字面克隆**（AST 指纹，能抓），这个抓**意图重复**（抓不到，但强制看一遍）。

### 必须知道的上界 [分析推论]

"名字不同、目的相同"的重复，**没有任何静态或索引机制能自动发现**。VSCode 也没有。可选解只有：粗筛 + agent 判定（如上）、或另做语义检索（embedding，当前项目没有）。

## 7. 当前实现的事实基线 [实测事实]

### 7.1 分层结构

| 层 | 位置 | 状态 |
|---|---|---|
| lightweight 词法索引 | `src/symbols/index/code-index.ts`（1194 行） | 默认可用，全机器唯一在跑的后端 |
| TypeScript 编译器层 | `src/symbols/semantic/typescript-heritage.ts`（499 行） | **代码已完备，但被 LSP 前置条件挡住**（见 7.4） |
| LSP 语义层 | `src/symbols/semantic/backend.ts`（2350 行） | 本机未安装任何语言服务器，registry 为空，整层不可达 |

### 7.2 lightweight 的语言覆盖真实情况

`parseCodeSymbols` 中**只有 3 个语言有专属规则**：Python（`def`/`class`）、Go（`func`/`type`）、Rust（`fn`）。JS/TS 走通用模式。其余约 14 种（c cpp csharp java kotlin php ruby scss shell sql svelte swift vue）**无任何针对性分支，全部用 JS 家族正则套用**。

**方法抽取正则缺陷**（`code-index.ts:598-601`）：

```
^[ \t]*(?:(?:public|private|protected|internal|static|abstract|override|virtual|final|async)\s+)*
(NAME)\s*\([^;\n]*\)\s*\{
```

要求右括号后只能是空白再接 `{`，因此**任何带返回类型标注的方法都不匹配**。Java/C#/C++ 的每个方法都带返回类型，故这些语言的方法抽取率接近全漏。

声明正则（`code-index.ts:569-572`）的可选修饰符只含 `export|default|declare|abstract`，**不含 `public`/`sealed`**，故 `public class Foo`（Java/C#）连类都抓不到。

*验证方式说明：以下结果是把上述两条通用正则单独取出、对 Java/C++/C#/Kotlin/Go 样本代码直接运行得到的（未走完整流水线；真实流水线还会先打掩码、跑 Go/Python/Rust 专属分支、并过滤含 `if|for|while|switch|catch` 的行）。*

| 样本 | 声明抓到 | 方法/函数抓到 |
|---|---|---|
| Java：`public class OrderService` + 3 方法 | **0 个 class** | 仅 constructor（蒙对） |
| C#：`public sealed class Cache` + 2 方法 | **0** | **0** |
| C++：`class Parser` + 3 函数 | class Parser | **0/3** |
| Kotlin：`class Repo` + `fun load` | class Repo | 0 |
| Go：`func (r *Repo) Load(...)` | 由 go 专属分支正确处理 | 但通用方法正则**额外产出名为 `func` 的假 method** |

TS 侧实测（同一缺陷）：`bump(): number {`、`get items(): string[] {`、`async save(): Promise<void> {` 全部漏。

### 7.3 本仓库真实索引统计

读取 `~/.myharness/agent/code-index/eef1049f61a900efd9efbe4ffd0e651a/index.json`（`version: 2`，`root: C:\MyHarness`，13,397,500 字节）：

- 1021 个文件 / **31,077 个符号**
- kind 分布：`constant=21988, function=4336, variable=1903, type=1212, interface=1127, method=310, class=201, struct=0, trait=0`
- **`constant` + `variable` 合计占 76.9%**
- 本仓库实际只索引到 **6 种语言**（typescript / javascript / json / yaml / shell / sql）——18 种语言要求中有 12 种在此仓库从未被检验
- **自我验证**：`code-index.ts` 自己被索引为 175 个符号、1 个 class、**method 仅 1 个（`constructor@740`）**；`ensureFresh` / `searchCode` / `getCodeMap` / `findSymbol` / `rebuild` 均不在索引中
- 全仓 201 class 只对应 310 method（TS 代码库中比例明显失真）

### 7.4 编译器层被 LSP 挡住（关键接线问题）

`typescript-heritage.ts` 已经做到：解析 `tsconfig.json`（含 project references、inferred project 兜底）→ `ts.createProgram` → **`program.getTypeChecker()`** → `checker.getSymbolAtLocation` / `getAliasedSymbol` 做真实跨文件符号解析（可穿 alias 与 re-export）→ 找 subtype 时遍历整个 Program 的所有源文件。有内容戳缓存、文件预算（`MAX_PROGRAM_FILES = 5000`、`MAX_PROJECTS = 8`）、以及"工作区外类型不列出"的诚实警告。

**它不需要语言服务器、不起进程、不联网**，只要求项目内能 `require("typescript/lib/typescript.js")`。

但 `analyzeHeritage` 全项目唯一业务调用点是 `semantic/backend.ts:1967` 的 `queryTypeHierarchyWithAdapter`，其开头为：

```
const definition = this.manager.registry.get(session.definitionId);
if (!definition || resolveServerProfile(definition).typeHierarchyAdapter !== "typescript") return undefined;
```

需要一个活的 LSP `ClientSession` 且 server profile 声明 `typeHierarchyAdapter === "typescript"`。**结论：精确且离线可用的跨文件解析，被"是否安装语言服务器"这个条件挡在门外。**

反证：`symbols/index/reuse-review.ts` 同样调用 `locateTypeScriptModule` + `loadTypeScript`，完全不碰 LSP，独立可运行。同一编译器能力在 gate 里随取随用，在符号查询里却要先装服务器。

补充：tsserver 本身不提供标准 `typeHierarchy` 请求——这正是 `typescript-heritage.ts` 文件头记录的存在理由。**所以"装好 LSP" ≠ 全能力，且缺失的恰是关联类能力。**

### 7.5 变更控制的真实状态

- `src/changes/mode.ts:13`：`DEFAULT_CHANGE_CONTROL_MODE = "assist"`。
- `src/changes/service.ts:320`：`if (this.mode !== "off")` 就执行全部 gates ⇒ **`StructuralReuseGate` 在默认 assist 模式下是运行的**，其命中克隆时返回 `allow:false` 会走到用户确认。
- `src/symbols/index/impact-coverage.ts:30`：`if (input.mode !== "strict") return { allow: true }` ⇒ **`ImpactCoverageGate` 默认不生效**。
- `StructuralReuseGate`（`reuse-review.ts`）实现要点：32 token 滑动窗口、对参数与局部变量做 alpha 重命名后再比指纹、嵌套函数独立计算不重复计入父体——因此能抓到"把逻辑抄进一个已有函数"。
- 但：只处理 `.[cm]?[jt]sx?`；编译器找不到 / 超字节预算 / 读失败 ⇒ `incomplete` ⇒ 非 strict 一律放行。

### 7.6 能力面与成本

- lightweight-only 下可成功的操作只有 5 个：`search_code`、`find_symbol`（名字**子串**匹配）、`file_symbols`、`code_map`、以及 legacy `query` 形式的 `find_definition` / `find_references`（后两者带 `completeness=partial` 警告）。
- 所有依赖位置的输入抛 `semantic backend is not configured`；`inspect_symbol` 的 9 个 facet 全部 `environment_blocked`。
- 排序缺失：`find_symbol` 是 `includes()` 后直接 `.slice(0, limit)`，**没有任何相关性排序**，故 76.9% 的常量/变量噪音直接冲淡结果排名。
- 截断：`find_symbol`/`find_definition`/`find_references`/`search_code` 上限 100，`file_symbols`/`code_map` 上限 500（`code-index.ts:183-186`）。索引预算 `maxFiles=10_000`、单文件 `1_000_000` 字节、总量 `50_000_000` 字节，超出则 `complete=false`。
- **重要**：`src/symbols/index/workspace-inventory.ts` 文件头明确要求"调用方不得把 no hit 读成 没有这个符号"。也就是说大型仓库里的"查不到"可能只是没扫到——这正是导致重复造轮子的失效模式。
- `search_code` / `find_references` 每次调用都**重新从磁盘读取每个已索引文件**并逐行匹配（索引只存符号不存内容，未帮上搜索）。
- *未在本会话复核（此前会话实测，引用时请再确认）*：symbols 工具 schema 序列化后约 19,330 字符 ≈ 5,369 token，约占默认工具 schema 总预算 63%；真实会话 24 次 symbols 调用中 22 次为 `search_code`，`grep` 0 次（因 grep 不在默认工具列表）。
- `scripts/symbols-plugin-entry.ts`（370 行 MCP stdio 入口）当前无任何引用。

## 8. 唯一尚未决定的一件事

**意图重复匹配是否需要索引保存代码正文。**

- 保存正文 → §6 的方案才成立，但索引规模将从 13MB 量级显著上升（正文远大于签名）。
- 不保存正文 → 只能做粗筛（名字分词 + 路径 + 一行签名），意图判定的负担全压在 agent 身上。

这是一个规模/能力权衡决策，不是 bug，也不是本文档能替用户决定的。

## 9. 给讨论者的提醒

1. 本文档 §7 的数字全部可复现（读取那个 index.json，或直接运行 §7.2 引用的正则）。若结论冲突，以实际运行为准。
2. **不要提议"给 TS 单独接编译器就好"作为整体方案**——用户已确定这是产品级、18 种语言的要求。接编译器可以作为 TS 的一档，但不能替代其余 17 种语言的方案。
3. 不要用"降低零漏改标准"作为解决方案。该标准的正确落点是 §5 的分区 + 处置机制，而不是把要求改成"尽量准"。
4. lightweight 的现有语义标签（`source=lightweight`、`partial`、警告文案）是**设计上的优点**，任何改动都应保留并加强这种自证性，而不是削弱它。
5. 本文档不含任何已批准的代码改动。§7 列出的缺陷是事实陈述，不构成修复授权。
