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
.\myharness-test.ps1
# 或双击/执行：.\dev.cmd
```

Windows 的开发入口会从脚本位置定位仓库，并复用 `myharness-test.ps1` 以 `tsx` 直接运行 `packages/coding-agent/src/cli.ts`；修改源码后不要求先 build。Linux/macOS 使用 `./myharness-test.sh`。这些脚本会保留调用者当前的项目工作目录。

## Provider 配置与启动约定

MyHarness 的 library 层采用手动 Provider 模式：`ModelRuntime.create()` 不自动加载上游 Provider 或模型目录，普通 Provider 和 model 来源是用户配置目录中的 `models.json`（Windows 默认是 `%USERPROFILE%\.myharness\agent\models.json`）。Coding Agent 产品入口另外注册受控的 OpenAI ChatGPT Provider，因此开发启动器启动产品时可在 Settings 中进入官方 ChatGPT 登录流程；其他 Provider 仍按下列规则处理：

- 不读取、同步或校验上游 Provider model catalog；
- 不执行任何上游模型目录生成或 hydrate；
- 不把上游 Provider 当作启动前置条件；
- 只使用 `models.json` 中的 Provider，以及明确注册的 extension Provider。

直接运行 `myharness-test.ps1` 会走 Coding Agent 产品入口并注册 OpenAI ChatGPT；其他 Provider 仍必须来自 `models.json` 或 extension。不要把本机生成的模型目录或用户配置复制回仓库。

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

交互式产品流程使用 `/commit` 创建本地 commit、使用 `/push` 发布已有 commit。`/push` 会基于当前 Workspace 的 upstream 做 fetch、fast-forward 检查、精确 branch Push、remote SHA 验证和当前 commit 的 branch-push CI 验收；它不会代替 `/commit` 整理普通工作树修改，也不会绕过 non-fast-forward、branch protection 或 CI 质量门槛。

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

为 fork 修改 `name`、`configDir` 和 `bin` 字段。这会影响 CLI banner、配置路径和 environment variable 名称。

## 路径解析

当前公开前可验证的是从源码运行的 tsx；npm package 和 standalone/Bun
binary 是独立的未来 release 路径，不能从本地 build 或源码目录推断已经
发布。Bun binary 另有 `build:binary`/`scripts/build-binaries.sh` 路径。

处理 package assets 时**始终使用 `src/config.ts`**：

```typescript
  import { getPackageDir, getThemesDir } from "./config.ts";
```

不要直接使用 `__dirname` 处理 package assets。

## 测试

```powershell
npm.cmd --workspace packages/coding-agent run test
npm.cmd run test
```

在 Git Bash 中也可以运行：

```bash
./test.sh                         # 运行 non-LLM tests（脚本会按环境跳过依赖 API 的测试）
./myharness-test.sh               # 从源码启动
npm --workspace packages/coding-agent run test -- test/specific.test.ts
```

## 项目结构

```
packages/
  ai/           # LLM Provider abstraction
  agent/        # Agent loop、harness 和 session abstractions
  tui/          # Terminal UI components
  coding-agent/ # CLI 和 interactive mode
  storage/
    sqlite-node/ # node:sqlite session storage backend
```
