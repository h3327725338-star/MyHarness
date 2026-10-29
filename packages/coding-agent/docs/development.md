# 开发指南

仓库级 Agent 硬规则见 [根目录 AGENTS.md](../../../AGENTS.md)；整体模块归属和依赖边界见 [架构与开发维护手册](../../../ARCHITECTURE_AND_DEVELOPMENT.md)。

## Agent 修改入口

修改 Coding Agent 前先读根 `AGENTS.md`，需要定位专题时使用
[`DOCUMENTATION_INDEX.md`](../../../DOCUMENTATION_INDEX.md)。按任务范围读取本页、
`maintenance.md`、`settings.md`、`usage.md` 或对应源码模块文档，再检查真实源码、
调用方、配置和测试；不要求无条件遍历整个仓库的 Markdown。仓库根 `AGENTS.md`
是开发规则入口，产品运行时的 `AGENTS.md`/`CLAUDE.md` 则由 context loader 作为
项目上下文注入，二者不要通过第二套规则系统复制。

修改产品交互前先阅读 [Interaction guidelines](interaction-guidelines.md)。它是
Settings、导航、Action、确认、反馈和键盘焦点行为的统一 contract；如果具体 Provider、
Session 或 Workspace 流程需要偏离，必须保留其数据关系并在代码中说明原因。

CI 的正式 baseline 见 [GitHub 自动化维护文档](../../../docs/maintenance/github-automation.md)：
只使用 `windows-2022` 和 `windows-2025`，两边执行相同流程且都必须通过。它们是
GitHub Windows Server 验证环境，不等于最终用户 Windows 桌面版本支持矩阵。

## 环境准备

公开仓库可用后，先从零建立 checkout：

```powershell
git clone https://github.com/h3327725338-star/MyHarness.git
cd MyHarness
```

```powershell
npm.cmd install --ignore-scripts
npm.cmd run build
```

从源码运行：

```powershell
node --import ./scripts/dev-fast-loader.mjs ./packages/coding-agent/src/web.ts
```

在仓库根目录执行，参数原样转发，保留调用者工作目录；修改源码后不要求先 build。`scripts/dev-fast-loader.mjs` 按根 `tsconfig.json` 的 paths 把 `@myharness/*` 指向源码，配合 Node 原生类型剥离运行 TypeScript。服务启动后不打开浏览器，只在日志打印 `MyHarness Web UI: <url>`；`--no-open` 仅为兼容保留。日常使用走桌面端 `dev-desktop.cmd`。原先的浏览器启动脚本（`dev-web.cmd`、`web-runtime.ps1`、`web-source.ps1`、`web-source.sh` 等）已移除。

## Provider 配置与启动约定

MyHarness 的 library 层采用手动 Provider 模式：`ModelRuntime.create()` 不自动加载上游 Provider 或模型目录，普通 Provider 和 model 来源是用户配置目录中的 `models.json`（Windows 默认是 `%USERPROFILE%\.myharness\agent\models.json`）。Coding Agent 产品入口唯一的现成 Provider 是 Nebius Token Factory 预设：它在用户粘贴 Key 时才写入 `models.json`（`providers/models/nebius-preset.ts`、`application/use-cases/nebius-setup.ts`），之后就是普通的 `models.json` Provider。Provider 按下列规则处理：

- 不读取、同步或校验上游 Provider model catalog；
- 不执行任何上游模型目录生成或 hydrate；
- 不把上游 Provider 当作启动前置条件；
- 只使用 `models.json` 中的 Provider，以及明确注册的 extension Provider。

直接运行源码入口会走 Coding Agent 产品入口；Provider 必须来自 `models.json` 或 extension。不要把本机生成的模型目录或用户配置复制回仓库。

## 推送前检查

推送前遵循以下顺序，避免把本机配置或上游生成物带入远端：

```powershell
git status --short --branch
git diff --check
npm.cmd run check
git diff --stat
# 仅在确认远端目标和授权后 push
```

确认 `git status` 中没有 `.myharness/`、`data/`、`dist/`、`node_modules/` 或其他本机生成物后再提交。若 `git push` 报 non-fast-forward，先停止并检查远端提交；没有明确授权时不要使用 `--force` 或 `--force-with-lease` 覆盖远端历史。

交互式产品流程使用 `/commit` 创建本地 commit、使用 `/push` 发布已有 commit。`/push` 会基于当前 Workspace 的 upstream 做 fetch、fast-forward 检查、精确 branch Push（推送检查过的那个 commit SHA）和 remote SHA 验证；远端收到后请求即返回。“按提示词”模式（默认）在后台按远端分支名查询这个 commit 的 branch-push CI，结果作为单独的卡片出现，Push 提示词要求 CI 通过时在 Chat 里修复并重新提交、Push，最多 3 轮；“直接”模式不查 CI。它不会代替 `/commit` 整理普通工作树修改，也不会绕过 non-fast-forward、branch protection 或 CI 质量门槛。

## Fork / Rebranding

通过 `package.json` 配置：

```json
{
  "myHarnessConfig": {
    "name": "myharness",
    "configDir": ".myharness"
  }
}
```

为 fork 修改 `name`、`configDir` 和 `bin` 字段。这会影响 Web 启动信息、配置路径和 environment variable 名称。

## 路径解析

当前公开前可验证的是经 `scripts/dev-fast-loader.mjs` 从源码运行和桌面端打包；npm package 和 standalone/Bun
binary 是独立的未来 release 路径，不能从本地 build 或源码目录推断已经
发布。Bun binary 另有 `build:binary`/`scripts/build-binaries.sh` 路径。

处理 package assets 时**始终使用 `src/config.ts`**：

```typescript
  import { getPackageDir } from "./config.ts";
```

包内静态资源用 `src/config.ts` 的 `getPackageDir()`、`getWebUiDir()`、
`getExportTemplateDir()`、`getDocsPath()` 等 helper 定位。主题 JSON 不从
`config.ts` 取：它只经 `src/themes/loader/index.ts` 的 `loadThemeResources()`
从全局/项目/显式路径加载并校验（Web 配色与终端渲染无关，见
[`themes.md`](themes.md)）。

不要直接使用 `__dirname` 处理 package assets。

## 测试

```powershell
npm.cmd --workspace packages/coding-agent run test
npm.cmd run test
```

在 Git Bash 中也可以运行：

```bash
./test.sh                         # 运行 non-LLM tests（脚本会按环境跳过依赖 API 的测试）
node --import ./scripts/dev-fast-loader.mjs ./packages/coding-agent/src/web.ts   # 从源码启动
npm --workspace packages/coding-agent run test -- test/specific.test.ts
```

## 项目结构

```
packages/
  ai/           # LLM Provider abstraction
  agent/        # Agent loop、harness 和 session abstractions
  coding-agent/ # Web UI、启动入口和产品 runtime
  desktop/      # Windows Electron host
  storage/
    sqlite-node/ # node:sqlite session storage backend
```
