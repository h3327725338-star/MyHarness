# MyHarness

MyHarness 是一个终端代码协作工具。它可以读取和修改项目文件、执行命令、调用模型、管理会话，并通过 skills、prompt templates 和 extensions 扩展能力。

> 当前状态：Early-stage / Work in Progress。源码、测试和文档正在收口，
> 不把未验证的 Provider、网络服务或 Code Intelligence Runtime 说成默认可用。

当前维护和验证环境是 Windows x64。源码中也保留了 Linux/macOS 启动脚本，
但本次发布前审计没有把其他平台的全新机器启动结果写成已验证事实。

## Windows 快速开始

从源码运行 MyHarness 需要 Node.js `>=22.19.0` 和可用的 Bash shell。Windows 用户安装 [Git for Windows](https://git-scm.com/download/win) 后即可使用 Git Bash；自定义 shell 路径见 [Windows 设置](packages/coding-agent/docs/windows.md)。

前置条件：

- Node.js `>=22.19.0`；
- Windows 上需要 Git for Windows 提供 Bash；
- 一个已经配置到 `models.json`、`/settings` 或 extension 中的 Provider/model，
  以及该 Provider 所需的凭据；仓库不内置默认 Provider catalog。

公开仓库可用后的全新 checkout 示例：

```powershell
git clone https://github.com/h3327725338-star/MyHarness.git
cd MyHarness
```

当前远端尚未由本轮改为公开；上面两条命令是公开后路径，不是本机当前
匿名访问已验证的结果。

在仓库根目录执行：

```powershell
npm.cmd install --ignore-scripts
npm.cmd run build                 # 构建全部 workspace 包
npm.cmd run build:offline         # 显式使用 offline 构建入口
.\dev.cmd                         # 启动源码版本
```

当前 `@myharness/coding-agent` 尚未出现在 public npm registry，因此这里的
可复现入口是源码启动器 `.\dev.cmd` 或 `.\myharness-test.ps1`；不要把 `npm install -g`
写成当前已经可用的安装方式。安装、认证和第一次会话见
[Quickstart](packages/coding-agent/docs/quickstart.md)。

最小使用流程：启动后在 `/settings` 配置 Provider 和 model，选择一个可用模型，
然后输入例如 `总结这个仓库的结构并告诉我如何运行检查。`。没有 Provider 凭据时，
可以运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\myharness-test.ps1 --help`
验证 CLI 启动，但不能声称完成真实模型会话。

## 开发与验证

```powershell
npm.cmd install --ignore-scripts
npm.cmd run build                 # Build all workspace packages
npm.cmd run check                 # Biome may rewrite files, then run checks
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\myharness-test.ps1  # Run MyHarness from sources
```

已有模型数据时，可以使用离线构建：

```powershell
npm.cmd run build:offline
```

完整测试脚本需要 Bash；在 Git Bash 中运行：

```bash
./test.sh                         # Run tests (skips LLM-dependent tests without API keys)
./myharness-test.sh               # Run MyHarness from sources
```

## 功能概览

- **对话式代码协作**：默认提供 `read`、`bash`、`pwsh`、`edit`、`write`、`symbols` 和 `github` 工具。
- **Provider 和模型管理**：通过 `/settings` 配置 Provider、API Key 和默认模型，通过 `/model` 或 `Ctrl+T` 切换模型。
- **交互式工作流**：支持文件引用（输入 `@`）、命令补全（输入 `/`）、Shell 命令（`!command`）、消息排队、thinking effort 和后台 Explore/视觉任务。
- **会话管理**：会话自动保存，可继续、浏览、分支和导出；长会话支持自动或手动 `/compact` 压缩上下文。
- **项目上下文与信任**：读取项目中的 `AGENTS.md` / `CLAUDE.md`，并在加载项目设置、skills 或 extensions 前执行项目信任控制。
- **可扩展能力**：支持 skills、prompt templates、TypeScript extensions、themes 和 MyHarness packages。
- **自动化与集成**：支持 `/workflow`、`/ultracode`、JSON event stream、SDK、GitHub 集成和自定义 Provider。

详细的命令和快捷键见 [使用说明](packages/coding-agent/docs/usage.md)。

## 任务弹窗提醒

交互模式下，任务结束时会自动弹出一个桌面弹窗提醒（人不在终端前也能第一时间知道）：

- **做完**：任务正常完成；
- **发生异常**：任务失败或执行超时；
- **任务中断**：任务被取消（如按 Esc 中断）或需要你处理。

弹窗在任务真正收尾（含自动重试、压缩和排队消息等收尾工作全部结束）后才会触发，同一次任务结果只弹一次。默认使用 Windows Toast 通知（macOS 走系统通知，Linux 走 notify-send），不需要额外安装任何东西。

### 配置

在 `%USERPROFILE%\.myharness\agent\settings.json`（全局）或项目 `.myharness\settings.json` 中配置：

项目配置保留在 `.myharness\`；当前 Session 数据按 workspace/session 保存于项目根目录的 `data\workspaces\...\sessions\...\conversation\`，旧版扁平 Session 数据可能位于 `data\sessions\`。

```json
{
  "popupNotifications": {
    "enabled": true,
    "style": "toast",
    "onCompleted": true,
    "onError": true,
    "onInterrupted": true
  }
}
```

- `enabled`：总开关（默认开启）；
- `style`：`"toast"`（系统通知，默认）或 `"window"`（经典对话框窗口，需手动关闭）；
- `onCompleted` / `onError` / `onInterrupted`：分别控制完成、异常、中断三类提醒（默认全部开启）。

总开关也可以直接在会话内执行 `/settings`，用 **Popup notifications** 开关切换（立即生效，无需重启）。

例如只保留异常提醒：`{"popupNotifications": {"style": "window", "onCompleted": false, "onInterrupted": false}}`。

## Code Intelligence（代码智能）

MyHarness 的 `symbols` 工具默认使用轻量索引，无需下载语言服务器。Windows x64 用户可以在会话内打开 `/settings` → `Code Intelligence`，按语言安装可选的语义模块；安装文件保存在 `%USERPROFILE%\.myharness\agent\code-intelligence\`，不会写入项目 Session 数据。

代码智能可用于查看文件符号、查找定义、引用、实现和诊断。使用 `status` 操作可以查看当前运行时注册的后端；查询结果中的 `source` 会标明使用的是 `semantic` 还是 `lightweight` 后端。

语义模块的发布清单位于 `packages/coding-agent/code-intelligence/runtime-manifest.json`，安装前会校验准确的文件大小和 SHA-256。当前源码只保留轻量级默认能力、清单、启动器和许可证；如果清单还没有发布归档，界面会明确显示不可用，不会下载未验证的文件。高级用户仍可在全局 `%USERPROFILE%\.myharness\agent\settings.json` 或当前项目的 `.myharness\settings.json` 中配置外部语言服务器，项目设置会覆盖全局设置。

## 数据与隐私

项目级设置位于 `.myharness\`；Session、Workspace metadata、运行时 trace
和其他项目数据位于被 Git 忽略的 `data\`。全局设置、凭据、模型缓存、信任记录、
memory 和下载的可选模块位于 `%USERPROFILE%\.myharness\agent\`。这些内容可能包含
代码、对话、路径或凭据，发布前不要复制到仓库或未经脱敏地附加到 issue。完整路径和
生命周期见 [存储与数据边界](docs/STORAGE.md)，报告安全问题见 [SECURITY.md](SECURITY.md)。

## 文档

- [架构与开发维护手册](ARCHITECTURE_AND_DEVELOPMENT.md)
- [根维护手册](MAINTENANCE.md)
- [根后续开发边界](DEVELOPMENT_ROADMAP.md)
- [Agent 修改规则](AGENTS.md)
- [完整文档索引](packages/coding-agent/docs/index.md)
- [使用说明](packages/coding-agent/docs/usage.md)
- [设置](packages/coding-agent/docs/settings.md)
- [Provider 和模型](packages/coding-agent/docs/providers.md)
- [Windows 设置](packages/coding-agent/docs/windows.md)
- [开发指南](packages/coding-agent/docs/development.md)
- [源码模块地图](packages/coding-agent/docs/source-modules.md)
- [产品维护手册](packages/coding-agent/docs/maintenance.md)
- [完整文档总索引](DOCUMENTATION_INDEX.md)
- [存储与数据边界](docs/STORAGE.md)
- [当前项目状态](PROJECT_STATUS.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)

## License

MyHarness 自身使用 Apache-2.0。继承代码和第三方组件继续保留各自的
license、copyright 和 attribution；详见 [LICENSE](LICENSE)、[NOTICE](NOTICE)
和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
