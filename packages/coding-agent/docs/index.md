# MyHarness 文档

MyHarness 是一个轻量的终端代码协作工具。核心保持精简，同时可以通过 TypeScript extensions、skills、prompt templates、themes 和 MyHarness packages 扩展能力。

## 快速开始

当前仓库尚未把 `@myharness/coding-agent` 发布到 public npm registry。首次
使用请从源码 checkout 运行（Windows）：

```powershell
npm.cmd install --ignore-scripts
npm.cmd run build
.\dev.cmd
```

完成未来 npm 发布后，才使用 `npm install -g --ignore-scripts
@myharness/coding-agent`。当前从源码运行不需要全局安装。

未来 npm 发布版本安装后，使用 npm 卸载 MyHarness：

```bash
npm uninstall -g @myharness/coding-agent
```

如果通过 pnpm、Yarn 或 Bun 安装，请使用对应的 global remove command：`pnpm remove -g @myharness/coding-agent`、`yarn global remove @myharness/coding-agent` 或 `bun uninstall -g @myharness/coding-agent`。

然后在项目目录中运行：

```bash
myharness
```

启动 MyHarness 前，先在 `models.json`、Settings 或 extension 中配置 Provider/model，再设置该 Provider 对应的 API Key 或通过 model selector 配置认证。当前版本没有默认 Provider catalog。

完整的首次运行流程见[快速开始](quickstart.md)。

## 从这里开始

- [快速开始](quickstart.md) - 安装、认证并运行第一个 session。
- [使用说明](usage.md) - 交互模式、Slash Commands、Context Files 和 CLI 参考。
- [Providers](providers.md) - 当前已配置/注册 Provider、API Key 和模型目录。
- [llama.cpp](llama-cpp.md) - 运行本地 router 和管理 models。
- [安全](security.md) - Project Trust、sandbox 边界和漏洞报告。
- [Containerization](containerization.md) - 使用 Gondolin、Docker 或 OpenShell 隔离 MyHarness。
- [设置](settings.md) - 全局和项目级设置。
- [Web Search](web-search.md) - 使用 SearXNG 和 Crawl4AI 的 Agent 联网搜索与网页读取。
- [快捷键](keybindings.md) - 默认快捷键和自定义快捷键。
- [Sessions](sessions.md) - session 管理、分支和树状导航。
- [Compaction](compaction.md) - 上下文压缩和分支总结。
- [Git Worktrees](worktrees.md) - 使用 `/git` 管理开发分支的独立工作目录。

## 定制

- [Extensions](extensions.md) - 为 tools、commands、events 和 custom UI 提供 TypeScript modules。
- [Skills](skills.md) - 可复用、按需调用的 Agent Skills。
- [Prompt templates](prompt-templates.md) - 可通过 command completion 调用的可复用 prompts。
- [Themes](themes.md) - 内置和自定义 terminal themes。
- [MyHarness packages](packages.md) - 打包和共享 extensions、skills、prompts 和 themes。
- [Custom models](models.md) - 为受支持的 Provider API 添加 model entries。
- [Custom providers](custom-provider.md) - 实现 custom APIs 和 OAuth flows。

## 编程方式使用

- [SDK](sdk.md) - 将 MyHarness 嵌入 Node.js applications。
- [JSON event stream mode](json.md) - 输出 structured events 的 print mode。
- [TUI components](tui.md) - 为 extensions 构建 custom terminal UI。

## 参考

- [Session format](session-format.md) - JSONL session file format、entry types 和 SessionManager API。

## 平台设置

- [Windows](windows.md)
- [Termux on Android](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## 开发

- [架构与开发维护手册](../../../ARCHITECTURE_AND_DEVELOPMENT.md) - 当前源码对应的整体架构、模块归属、依赖边界和验证规则。
- [Agent 修改规则](../../../AGENTS.md) - 面向 Coding Agent / AI Agent 的简洁硬规则。
- [开发指南](development.md) - 本地环境、项目结构和 debugging。
- [源码模块地图](source-modules.md) - 当前 `src` 一级目录、职责和开发边界。
- [产品维护手册](maintenance.md) - 启动装配、Provider、Session、Prompt、工具和验证规则。
- [后续开发边界](roadmap.md) - 基于当前源码的候选方向和验收条件。

### 历史架构记录

以下文档记录历史重构阶段，不是当前架构的唯一入口；当前结构以仓库根目录的架构与开发维护手册、源码和 package 配置为准。

- [架构重构 Phase 0 基线](architecture-baseline.md) - 历史 API、格式、启动链和关键行为基线。
- [架构重构 Phase 1 边界](phase1-architecture-boundaries.md) - 历史业务工具、Theme resource 和展示层边界。
- [架构重构 Phase 2 边界](phase2-architecture-boundaries.md) - 历史 Extension contracts、兼容入口和 API Entry 边界。
- [架构重构 Phase 3 边界](phase3-architecture-boundaries.md) - 历史 AgentSession、InteractiveMode 和 application use-case 边界。
