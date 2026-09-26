# MyHarness 文档索引

[English](index.md) | [简体中文](index.zh-CN.md)

MyHarness 是一个终端代码协作工具。Coding Agent 产品层提供 CLI、AgentSession、工具、Session、Provider runtime、project trust 以及 extension/resource 系统。

## 快速开始

当前仓库尚未把 `@myharness/coding-agent` 发布到 public npm registry。Windows 用户请从源码 checkout 运行：

```powershell
npm.cmd install --ignore-scripts
npm.cmd run build
.\dev.cmd
```

启动 model-backed session 前，请先登录内置的 OpenAI ChatGPT Provider，或在 `models.json`、Settings、extension 中配置其他 Provider 和 model。library 层的 `ModelRuntime.create()` 仍然不会自动加载 Provider，只有产品入口或 extension 显式注册后才会出现 catalog。首次运行流程见 [Quickstart](quickstart.md)。

## 从这里开始

- [Quickstart](quickstart.md) — 安装、配置认证并运行第一个 Session。
- [使用说明](usage.md) — Interactive mode、Slash Commands、context files 和 CLI 参考。
- [Providers](providers.md) — Provider 配置、credentials 和 model runtime 边界。
- [llama.cpp](llama-cpp.md) — 运行本地 router 和管理 models。
- [安全](security.md) — Project Trust、sandbox 边界和漏洞报告。
- [Containerization](containerization.md) — 使用 Gondolin、Docker 或 OpenShell 隔离 MyHarness。
- [设置](settings.md) — 全局和项目级设置。
- [Windows](windows.md) — Bash 和 Windows 专用设置。
- [Web Search](web-search.md) — 可选的内置联网搜索（DuckDuckGo、Brave、Brave Search API）和网页读取。
- [Sessions](sessions.md) — Session 管理、分支和导航。
- [Compaction](compaction.md) — context compaction 和 branch summaries。
- [Git Worktrees](worktrees.md) — 通过 `/git` 管理开发 worktree。
- [快捷键](keybindings.md) — 默认快捷键和自定义方式。
- [TUI 设计系统](tui-design-system.md) — 视觉层级、共享 token、状态投影和终端交互规则。

## 扩展能力

- [Extensions](extensions.md) — 为 tools、commands、events 和 custom UI 提供 TypeScript modules。
- [Skills](skills.md) — 可复用、按需调用的 Agent Skills。
- [Prompt templates](prompt-templates.md) — 通过 command completion 调用的可复用 prompts。
- [Themes](themes.md) — 内置和自定义 terminal themes。
- [MyHarness packages](packages.md) — 打包和共享 extensions、skills、prompts 与 themes。
- [Custom models](models.md) — 为已配置的 Provider API 添加 model entries。
- [Custom providers](custom-provider.md) — 实现 custom APIs 和 OAuth flows。

## 编程方式使用

- [SDK](sdk.md) — 在 Node.js application 中嵌入 MyHarness。
- [JSON event stream mode](json.md) — 从 print mode 输出 structured events。
- [TUI components](tui.md) — 为 extensions 构建自定义 terminal UI。

## 参考与平台设置

- [Session format](session-format.md) — JSONL format、entry types 和 SessionManager API。
- [Termux on Android](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## 开发

- [架构与开发维护手册](../../../ARCHITECTURE_AND_DEVELOPMENT.md) — 当前模块归属、依赖边界和验证规则。
- [Agent 规则](../../../AGENTS.md) — Coding Agent 和 AI Agent 工作时的仓库规则。
- [开发指南](development.md) — 本地环境、项目结构和 debugging。
- [源码模块地图](source-modules.md) — 当前顶层 `src` 目录和职责。
- [产品维护手册](maintenance.md) — 启动装配、Provider、Session、Prompt、工具和验证规则。
- [后续开发边界](roadmap.md) — 基于当前源码的候选工作和验收边界。

### 历史架构记录

以下文档记录早期重构阶段，仅作为历史背景，不是当前架构的唯一依据；当前行为应以根目录手册、源码和 package 配置为准。

- [架构重构 Phase 0 基线](architecture-baseline.md)
- [架构重构 Phase 1 边界](phase1-architecture-boundaries.md)
- [架构重构 Phase 2 边界](phase2-architecture-boundaries.md)
- [架构重构 Phase 3 边界](phase3-architecture-boundaries.md)
