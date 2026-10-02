# providers/ — Provider、模型与凭证

## 说明

### 职责

产品层的模型运行时：有哪些 Provider 和模型、用哪个凭证、请求失败后怎么恢复。底层的 API 适配器（各家协议的请求与流式解析）在 `packages/ai`，不在这里。

MyHarness 不内置任何 Provider。可用的 Provider 和模型来自 `models.json`、模型缓存、已保存的凭证和扩展注册。

### runtime/ — 运行时入口

| 文件 | 内容 |
| --- | --- |
| `provider-runtime.ts` | `ModelRuntime`：组合 `models.json`、模型缓存、凭证和扩展 Provider；提供模型查询、认证解析、刷新、启用/禁用、流式请求入口 |
| `model-resolver.ts` | 模型引用解析：`--model`/`--models` 的模式匹配、初始模型选择、从 Session 恢复模型 |
| `session-model.ts` | `SessionModelController`：一个会话当前用哪个模型和 Thinking 档位。负责切换、循环（`--models` 范围或全部可用模型）、Provider 配置变更后的校正、热重载 Provider 配置 |
| `request-auth.ts` | 压缩与分支摘要请求的凭证解析；没有 API Key 时给出用户指引 |
| `auth-guidance.ts` | “没有模型 / 没有 API Key”时给用户的提示文案 |
| `attribution.ts` | 合并 Provider 归因请求头 |
| `balance-tracker.ts` | 支持余额接口的 Provider 的余额查询与轮询 |
| `index.ts` | 出口 |

### models/ — 模型配置

| 文件 | 内容 |
| --- | --- |
| `config.ts` | `ModelConfig`：`models.json` 的只读快照（不含凭证） |
| `composer.ts` | 把一个 Provider 的配置组合成可用的 Provider/模型；请求头与兼容请求配置解析；API Key 缓存 |
| `custom-provider-manager.ts` | 用户自定义 Provider 的增删改、模型发现、把发现结果写回 `models.json` |
| `thinking-capability.ts` | 判断一个模型的 Thinking Effort 能力来自哪里（官方文档 > 模型目录 > 探测） |
| `official-effort.ts` | Provider 官方文档明确写出的“请求档位 → 实际档位” |
| `thinking-probe.ts` | 用真实的最小请求探测 Thinking Effort |
| `store.ts` | 模型缓存（`models-store.json`） |
| `disabled.ts` | Provider 启用/禁用策略 |
| `registry.ts` | `ModelRegistry`：给扩展和部分界面用的兼容门面 |
| `usage-ranking.ts` | 按使用次数排序模型 |

### credentials/ — 凭证

| 文件 | 内容 |
| --- | --- |
| `auth-storage.ts` | `AuthStorage`：`auth.json` 的读写（带锁） |
| `runtime.ts` | `RuntimeCredentials`：在持久凭证之上叠加仅本次运行有效的 API Key |
| `manager.ts` | `ProviderCredentialManager`：凭证存储的装配与旧 Vision 凭证的一次性迁移 |
| `api-key-collection.ts` | 一个 Provider 多个 API Key 的存储契约 |
| `value-resolution.ts` | 配置值解析：字面量、环境变量、`!命令` |
| `account-connections.ts` | `AccountConnections`：GitHub Connect（设备码登录），存 `account-connections.json` |
| `web-search-keys.ts` | `WebSearchApiKeys`：搜索引擎 API Key 的独立私有文件 |

### recovery/ — Provider 故障恢复

| 文件 | 内容 |
| --- | --- |
| `policy.ts` | 哪些失败可恢复、恢复预算、恢复时发给模型的内部消息 |
| `coordinator.ts` | `ProviderRecoveryCoordinator`：本地任务在 Provider 会话失败后继续或重建会话，次数有上限 |

### 对外接口

`src/index.ts` 导出 `ModelRuntime`（`runtime/index.ts`）、`model-resolver.ts`、`AuthStorage`、`api-key-collection.ts`、`ModelRegistry`。

### 依赖

- 依赖：`@myharness/ai`、`config/settings`、`src/config.ts`、`utils`、`observability/telemetry.ts`、`agent/runtime/defaults.ts`、`session/manager`（类型，`session-model.ts` 记录模型与 Thinking 变更）、`cli/args.ts`（类型）。
- 被依赖：`agent/runtime`、`agent/vision`、`cli`、`modes/*`、`extensions/runtime`、`git/ci`、`tools/github`、`main.ts`。

## 维护

- 凭证不得进入日志、Trace、Session 或 Settings。界面只能拿到标签和末四位。
- “API 适配器存在”不等于“Provider 可用”：是否可用取决于配置、凭证和注册。文档和提示里不要写成内置支持。
- 环境变量只在对应 Provider 已存在时参与认证解析，本身不会创建 Provider。
- 不按模型名猜测 Thinking 能力；顺序固定为官方文档 > 模型目录 > 探测。
- `models.json`、`auth.json` 的写入必须保留现有的锁和原子替换。
- 恢复策略有预算上限，改动时确认不会把同一个 Provider 故障变成无限循环（`agent-session-provider-recovery.test.ts`）。
- 用户文档：`docs/providers.md`、`docs/models.md`、`docs/custom-provider.md`、`docs/security.md`。
- 相关测试：`model-runtime-*.test.ts`、`model-resolver.test.ts`、`model-registry.test.ts`、`models-store.test.ts`、`configured-providers.test.ts`、`custom-provider-manager.test.ts`、`auth-storage.test.ts`、`runtime-credentials.test.ts`、`resolve-config-value.test.ts`、`account-connections.test.ts`、`thinking-probe.test.ts`、`official-effort.test.ts`、`balance-tracker.test.ts`、`phase7-provider-architecture.test.ts`。
