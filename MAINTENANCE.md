# MyHarness 根维护手册

本手册只描述当前仓库的维护边界。产品使用方法见 `packages/coding-agent/docs/`；整体目录和依赖方向见 `ARCHITECTURE_AND_DEVELOPMENT.md`。

修改 MyHarness 的 Agent 先读根 `AGENTS.md`，再按 `DOCUMENTATION_INDEX.md` 路由到
对应专题文档；只读取与任务相关的专题，不要求无条件遍历整个仓库的 Markdown。

## 仓库边界

- 根目录是 npm/TypeScript/ESM monorepo，workspace 包在 `packages/*` 和 `packages/storage/*`。
- 构建顺序由根 `package.json` 固定为 `tui → ai → agent → storage/sqlite-node → coding-agent`。
- `data/` 是运行时数据目录并被 Git 忽略；不要把 session、cache、trace、credential 或本机生成物当作源码提交。
- `.myharness/settings.json` 是当前项目配置，不是用户级 credential 存储；全局 auth、models 和 session 路径由 Coding Agent 配置代码决定。
- 具体用户数据、Session、Workspace、trace、memory 和 Code Intelligence runtime 的边界见 [`docs/STORAGE.md`](docs/STORAGE.md)；发布前审计不得删除这些真实数据。

## 安装、构建和检查

Windows 源码环境需要 Node.js `>=22.19.0` 和 Bash。首次安装使用：

```powershell
npm.cmd install --ignore-scripts
npm.cmd run build
```

已有模型缓存时可使用 `npm.cmd run build:offline`。根脚本还提供：

| 命令 | 当前行为 | 是否写入 |
| --- | --- | --- |
| `npm.cmd run build` | 按 workspace 顺序构建全部包；当前 AI package 的 `build` 脚本委托给 `build:offline` | `dist/`、资源和构建缓存 |
| `npm.cmd run build:offline` | 显式使用 AI offline 构建，再构建其余包 | `dist/`、资源和构建缓存 |
| `npm.cmd run test` | 调用各 workspace 自己的 `test` 脚本 | 取决于测试/coverage 配置 |
| `npm.cmd run check` | `biome check --write` 后并行运行 pinned deps、TS imports、shrinkwrap、install-lock、`tsgo` 和 browser smoke | **会改写格式化文件**，并产生检查缓存 |
| `npm.cmd run check:ts-imports` | 检查非 declaration `.ts` 的相对 `.js` import | 只读 |
| `npm.cmd run check:pinned-deps` | 检查外部 dependency 使用精确版本 | 只读 |
| `npm.cmd run check:shrinkwrap` | 校验 Coding Agent 发布 shrinkwrap | 只读 |
| `npm.cmd run check:install-lock:coding-agent` | 校验 Coding Agent install lock | 只读 |

如果需要只读证据，优先单独运行对应的 `check:*`；不要把 `npm run check` 称为只读检查。

## CI baseline 与用户平台

正式 GitHub CI 是 `.github/workflows/ci.yml`，固定使用 `windows-2022` 和
`windows-2025` 两个 GitHub-hosted Windows x64 runner。matrix 两边执行相同的
`npm ci --ignore-scripts`、release/privacy audit、`ffmpeg-static` rebuild、build、
check、搜索工具安装和 test 流程；两边都必须通过，不能使用 `windows-latest`。

这是自动化验证 baseline，不是最终用户支持矩阵。MyHarness 面向 Windows 桌面 x64，
不能把 CI 的 Windows Server runner 写成“只支持 Windows Server”，也不能声称已
逐一验证 Windows 10/11 的每个桌面版本。其他 release、audit、binary 或协作
workflow 的 runner 只属于各自自动化范围；本仓库没有为这条正式 CI baseline 新增
Linux/macOS runner。

## 改动流程

1. 先看 `git status --short`，保留已有工作区改动。
2. 准备 stage、commit、push 或执行其他 Git 写操作前，先读
   [`docs/maintenance/git-workflow.md`](docs/maintenance/git-workflow.md)；普通源码阅读不需要读该文档。
3. 根据领域读取真实源码、package exports、调用方、测试和相关文档。
4. 修改后只同步直接受影响的文档；不要为历史 changelog 或历史 Phase 文档改写当前语义。
5. 用 `git diff --check`、相关测试或静态检查验证，并确认改动文件没有越出任务范围。
6. 若涉及 build、lockfile、Session、配置、发布或用户目录，单独报告这些写入影响。

## 公共 contract 的维护重点

- Agent Core：`AgentOptions`、Agent event、stream function、tool execution、取消和队列语义必须保持兼容；Agent Core 不依赖具体 TUI。
- AI：Provider 必须声明 auth；`Models` 负责 Provider 注册、auth resolution、model refresh 和 stream delegation。不要把“API implementation 存在”写成“Provider 已注册”。
- Coding Agent：`ModelRuntime` 组合 `models.json`、模型 store、credential 和 extension provider；公共出口保持通过 `src/index.ts` 或声明的 package exports。
- Session：格式、版本、migration、JSONL 容错和 projection 必须一起检查；不要让 UI 直接写 Session 文件。
- SQLite：schema 变更必须有 migration、materialized state 更新和 `packages/agent/test/harness` 覆盖。
- TUI：组件必须遵守 `render(width)`、`invalidate()`、焦点和 overlay contract；展示层不能反向承载业务状态。
- Prompt：固定文本在仓库 `system-prompts/`，组合逻辑在 Coding Agent composer；用户项目的 `SYSTEM.md`、`APPEND_SYSTEM.md`、`AGENTS.md`、`CLAUDE.md` 和 skills 仍由各自 loader 管理。仓库自身的开发规则、CI 和维护流程只放在根 `AGENTS.md` 与仓库文档中。

## 敏感数据和发布

不要在日志、文档、测试输出或 diff 中写入 API key、OAuth token、cookie、authorization header、refresh token、PKCE/state 或真实用户 Session 内容。发布脚本、版本脚本、shrinkwrap 和 binary 构建会写入多个文件，执行前应先确认目标。

CI、发布和提交钩子的实际入口见 [`scripts/README.md`](scripts/README.md) 和
[GitHub 自动化维护文档](docs/maintenance/github-automation.md)；Git stage、commit 和
push 的检查顺序以 [`docs/maintenance/git-workflow.md`](docs/maintenance/git-workflow.md) 为准。
提交前、推送前和版本发布前的敏感信息检查统一由
[`scripts/release-audit.mjs`](scripts/release-audit.mjs) 提供；固定流程和匿名事故记录见
[`docs/RELEASE_GATE.md`](docs/RELEASE_GATE.md)。

机器可检查的约束应由 workflow、脚本和测试执行；Agent Prompt 和维护文档负责
说明规则、边界和路由，不能替代实际命令或远端 run 证据。

## 公开历史边界

公开仓库使用独立的 orphan public history；本地 `main` 仍保留既有私有历史。
后续公开版本应从准备好的公开源码树重新执行隐私、License、LFS 对象和发布
资产审计，不应直接把本地私有历史推送到公开分支。当前项目阶段、明确未完成项
和 Code Intelligence 发布前置条件见 [`PROJECT_STATUS.md`](PROJECT_STATUS.md)。
