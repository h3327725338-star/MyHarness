# config/ — 设置、路径与项目信任

## 说明

### 职责

集中管理三类东西：配置和数据放在哪（paths）、设置怎么读写与合并（settings）、项目是否被信任（trust）。其他模块不应自己拼路径或直接读写这些 JSON。

包根的 `src/config.ts` 是更底层的入口（应用名、版本、Agent 目录、包内资源路径、安装方式检测）；本目录在它之上。

### paths/

`index.ts`：全部路径函数。

- 设置：`getGlobalSettingsPath()`、`getProjectSettingsPath()`、`getProjectConfigDir()`、`getTrustStorePath()`
- 数据根：`getDataDir()`、`getWorkspacesDir()`、`getWorkspaceRegistryPath()`
- Workspace / Session 作用域：`getWorkspaceDir()`、`getSessionDir()`、`getSessionConversationPath()`、`getSessionMetadataPath()`、`parseSessionDataPath()` 等
- 未绑定会话：`UNBOUND_WORKSPACE_ID`、`getDefaultWorkingDir()`

### settings/

| 文件 | 内容 |
| --- | --- |
| `types.ts` | `Settings` 及各分组的类型（压缩、重试、终端、图片、Sub-agent、Auto Memory、Vision、Web Search、Git、Code Intelligence 等） |
| `defaults.ts` | 默认值、`mergeSettings()`、Web Search 的取值范围 |
| `storage.ts` | `SettingsStorage` 接口，`FileSettingsStorage`（带锁和原子写）与 `InMemorySettingsStorage` |
| `migrations.ts` | `migrateSettings()`：旧字段迁移 |
| `manager.ts` | `SettingsManager`：全局 + 项目两级设置的读取、合并、写入和重载 |
| `index.ts` | 对外出口 |

### trust/

| 文件 | 内容 |
| --- | --- |
| `index.ts` | `ProjectTrustStore`（`trust.json`）、信任选项、`hasTrustRequiringProjectResources()` |
| `settings-access.ts` | 项目设置在当前信任状态下能否读、能否写 |

### 对外接口

`src/index.ts` 公开导出 `config/paths`、`config/settings`、`config/trust` 的出口。`SettingsManager` 是几乎所有领域读取配置的入口。

### 依赖

- 依赖：`src/config.ts`、`utils`（原子写、路径、弹窗通知类型）、`context/context-window.ts`（上下文窗口设置的规范化）、`platform/process/http-dispatcher.ts`（超时选项）。
- 被依赖：几乎所有领域。

## 维护

- 新增设置项：改 `types.ts`、`defaults.ts`、`manager.ts` 的 getter/setter；若改名或改结构，在 `migrations.ts` 加迁移。同步 `docs/settings.md`，需要出现在菜单里时再改 `cli/settings-menu.ts`。
- 项目设置受 Project Trust 控制：不受信任时不读取、不写入。不要绕过 `settings-access.ts`。
- 写入必须走 `SettingsStorage`（文件锁 + 原子替换），不要在别处直接写 `settings.json`。
- 路径函数是数据布局的唯一来源；改动会影响已有用户数据，需要配套迁移（见 `session/migrations/`、`data/`）并同步 `docs/STORAGE.md`。
- API Key、OAuth Token 不属于 Settings，放在 `providers/credentials/`。
- 相关测试：`settings-manager*.test.ts`、`settings-project-override.test.ts`、`trust-manager.test.ts`、`config.test.ts`、`paths.test.ts`、`phase6-config-architecture.test.ts`。
