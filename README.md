# MyHarness

[![License: Apache-2.0](https://img.shields.io/github/license/h3327725338-star/MyHarness)](LICENSE)

MyHarness 是一个面向代码仓库的终端 AI 协作工具：它可以在当前项目目录中读取和修改文件、执行命令、调用已配置的模型，并管理可恢复的工作会话。

> 状态：Early-stage / Work in Progress。当前主要在 Windows x64 上维护和验证；项目仍需要用户自行配置 Provider、model 和凭据。

## 它解决什么问题

它把模型调用、仓库文件、Shell 命令和可恢复 session 放在同一个项目工作流中，让代码调查、修改、检查和后续继续工作共享上下文，同时由用户控制 Provider 和凭据。

## 它能做什么

- **代码协作**：默认提供 `read`、`bash`、`pwsh`、`edit`、`write`、`symbols` 和 `github` 工具。
- **交互与自动化**：支持 Interactive、Print 和 JSON event stream 模式，提供 Slash Commands、文件引用、Git 集成和 SDK。
- **项目上下文**：读取项目中的 `AGENTS.md` / `CLAUDE.md`，并管理 workspace、session、分支和上下文压缩。
- **可扩展**：支持 TypeScript extensions、skills、prompt templates、themes 和 MyHarness packages。
- **可选能力**：Explore sub-agent、`/workflow`、`/ultracode` 以及 Web Search 可按配置启用，默认不启用；Web Search 需要外部 SearXNG/Crawl4AI-compatible 服务。

## 当前状态

- 当前可靠的公开使用路径是从源码 checkout 运行；`@myharness/coding-agent` 尚未发布到 public npm registry。
- `symbols` 默认使用无需下载语言服务器的 lightweight index。重量级 Windows Code Intelligence runtime 当前没有已发布的校验归档，因此不把 semantic language-server 能力写成默认可用。
- Provider、OAuth、外部 Web Search、Linux/macOS 全新 checkout，以及真实交互终端行为，都需要各自的运行环境或凭据，不能仅由源码存在推出已验证成功。
- 完整的阶段说明、已确认能力和未验证边界见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。

## Quick Start（Windows 源码运行）

环境要求：Node.js `>=22.19.0`；如果要使用 Windows 上的 `bash` 工具，请安装 [Git for Windows](https://git-scm.com/download/win)。

```powershell
git clone https://github.com/h3327725338-star/MyHarness.git
cd MyHarness
npm.cmd install --ignore-scripts
npm.cmd run build
.\dev.cmd
```

启动后，在 `/settings` 中配置 Provider 和 model，再输入任务。仓库不内置默认 Provider catalog；配置方式见 [Providers](packages/coding-agent/docs/providers.md) 和 [Settings](packages/coding-agent/docs/settings.md)。

不需要 Provider 凭据时，可以先验证 CLI 是否能启动：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\myharness-test.ps1 --help
```

完整的首次会话流程见 [Quickstart](packages/coding-agent/docs/quickstart.md)。

## 文档

- [完整用户文档索引](packages/coding-agent/docs/index.md)
- [使用说明](packages/coding-agent/docs/usage.md)
- [Windows 设置](packages/coding-agent/docs/windows.md)
- [存储与数据边界](docs/STORAGE.md)
- [当前项目状态](PROJECT_STATUS.md)
- [架构与开发维护手册](ARCHITECTURE_AND_DEVELOPMENT.md)
- [开发指南](packages/coding-agent/docs/development.md)
- [源码模块地图](packages/coding-agent/docs/source-modules.md)
- [根维护手册](MAINTENANCE.md)
- [开发路线与边界](DEVELOPMENT_ROADMAP.md)
- [GitHub 自动化维护](docs/maintenance/github-automation.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [完整文档总索引](DOCUMENTATION_INDEX.md)

## 开发与贡献

从仓库根目录执行常用检查：

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run audit:release
```

`npm.cmd run check` 会运行格式化器并可能改写文件；测试、Provider 和平台验证的边界见 [开发指南](packages/coding-agent/docs/development.md)。欢迎通过 Issue 反馈问题或提交 Pull Request，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 处理。

## License

MyHarness 自身使用 [Apache License 2.0](LICENSE)。继承代码和第三方组件继续保留各自的 license、copyright 和 attribution，详见 [NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
