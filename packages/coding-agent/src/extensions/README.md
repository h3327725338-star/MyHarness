# extensions/ — 扩展系统

## 说明

### 职责

让用户用 TypeScript 模块扩展 MyHarness：订阅生命周期事件、注册工具、命令、快捷键、CLI 参数、Provider，以及通过 UI 上下文与用户交互。本目录负责契约、发现与加载、包管理、运行时执行。

### 顶层文件

| 文件 | 内容 |
| --- | --- |
| `api-entry.ts` | 加载后的扩展在运行时拿到的入口。它与 `src/index.ts` 分开，避免加载器反向依赖整个公共门面 |
| `index.ts` | `builtInExtensions`：内置扩展列表（当前为空数组） |

### contracts/ — 稳定契约

只放可传递的类型，不含实现。

| 文件 | 内容 |
| --- | --- |
| `tool.ts` | `ToolDefinition`：内置工具与扩展工具共用的执行契约 |
| `registration.ts` | 扩展工厂、内联扩展、已注册工具/参数/快捷键、错误记录 |
| `events.ts` | 事件名、事件信封、处理器和订阅 |
| `ui.ts` | 所有前端共用的 UI 端口（对话框、小组件位置、输入处理） |
| `source-info.ts` | `SourceInfo`：资源来自哪里（作用域、来源） |
| `diagnostics.ts` | 资源加载诊断与冲突 |

### loader/ — 发现与加载

| 文件 | 内容 |
| --- | --- |
| `index.ts` | 用 jiti 加载扩展模块；`discoverAndLoadExtensions()`、`loadExtensionsCached()`、`createExtensionRuntime()` |
| `resource-set.ts` | `ExtensionResourceLoader`：把已启用的路径和内联工厂变成一个 `LoadExtensionsResult` |

### packages/

`package-manager.ts`：`DefaultPackageManager`。管理 `settings.json` 里配置的扩展包（npm、Git、本地路径）的解析、安装、更新，以及包内资源（扩展、Skill、Prompt、Theme）的启用状态。

### runtime/ — 执行

| 文件 | 内容 |
| --- | --- |
| `types.ts` | 扩展 API 的完整类型面：`ExtensionAPI`、`ExtensionContext`、全部事件与返回值类型、`defineTool` |
| `runner.ts` | `ExtensionRunner`：分发事件、收集返回值、管理命令/工具/快捷键注册、上下文失效（reload 或换会话后旧 ctx 作废） |
| `wrapper.ts` | 把已注册工具包成 Agent 可调用的工具，并注入 runner 上下文 |
| `event-bus.ts` | 扩展之间的事件总线 |
| `agent-events.ts` | `ExtensionAgentEventForwarder`：把 Agent Core 的事件转成扩展事件并维护回合序号，`message_end` 的替换结果原地写回消息；`buildExtensionResourcePaths()`：给扩展运行时贡献的资源路径打上来源标记 |

### compat/ — 兼容面

`index.ts`、`types.ts`、`tool.ts`：历史上的公开类型路径。内容都是 re-export，保证旧的导入继续可用。

### 对外接口

- `src/index.ts` 导出 `extensions/compat`、`contracts/source-info.ts`、`packages/package-manager.ts`、`runtime/event-bus.ts`。
- 扩展作者看到的 API 以 `runtime/types.ts` 和 `api-entry.ts` 为准，说明见 `docs/extensions.md`。

### 依赖

- 依赖：`agent/runtime/messages.ts`、`cli/slash-commands.ts`、`context/compact`、`session`（manager、类型）、`system-prompts/composer`、`tools`、`providers/models/registry.ts`、`platform/process/exec.ts`、`git/repository`（包管理拉取 Git 源）、`modes/interactive`（仅类型：主题、快捷键、页脚数据）。
- 被依赖：`application`（ResourceLoader）、`agent/runtime`、`cli`、`modes/*`、`tools/contracts`、`prompts`/`skills`/`themes` 的 loader（只用 `contracts`）。

## 维护

- `contracts/` 只增不乱改：第三方扩展依赖这些类型。删除或改名前检查 `examples/extensions/` 和 `compat/`。
- 不要因为名字旧就删 `compat/`；它是公开导入路径。
- 加载器不得通过 `src/index.ts` 访问自身实现（会形成循环）；需要给扩展的东西放进 `api-entry.ts`。
- 工具调用拦截（`tool_call` / `tool_result`）在 `AgentSession` 安装的 Agent 钩子里完成，`wrapper.ts` 只负责注入上下文。
- 项目级扩展受 Project Trust 控制，判断在 `application/resource-loader.ts`。
- 新增事件：同时改 `contracts/events.ts`（事件名）、`runtime/types.ts`（事件与返回类型）、`runtime/runner.ts`（分发），并更新 `docs/extensions.md`。
- 相关测试：`extensions-discovery.test.ts`、`extensions-runner.test.ts`、`extensions-input-event.test.ts`、`package-manager*.test.ts`、`git-update.test.ts`、`compaction-extensions*.test.ts`、`plan-mode-*.test.ts`、`test/suite/regressions/` 中的扩展相关用例。
