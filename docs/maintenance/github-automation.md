# GitHub 自动化

`.github/workflows/` 中的 YAML 是 GitHub Actions 行为的事实来源；本文只提供入口、范围和维护边界，不把文档内容当作某次远端运行已经成功的证明。

## Workflow 范围

| Workflow | Runner | 作用 |
| --- | --- | --- |
| `ci.yml` | `windows-2022` + `windows-2025` matrix | 正式 CI baseline：完整安装、audit、build、check 和 test |
| `pr-gate.yml` | `ubuntu-latest` | Pull Request contributor gate；不是正式 CI baseline |
| `build-binaries.yml` | `ubuntu-latest` | 多平台 binary 构建和发布；不是正式 CI baseline |
| `npm-audit.yml` | `ubuntu-latest` | 独立 npm 依赖审计；不是正式 CI baseline |
| `issue-gate.yml` | `ubuntu-latest` | Issue gate |
| `issue-triage-labels.yml` | `ubuntu-latest` | Issue triage label |
| `approve-contributor.yml` | `ubuntu-latest` | 贡献者审批相关自动化 |
| `remove-inprogress-on-close.yml` | `ubuntu-latest` | Issue 关闭后的 label 清理 |

表中的辅助 workflow 是现有发布、审计和协作自动化，不是本轮新增的 Linux/macOS
产品 CI。正式 CI 只由 `ci.yml` 的两个固定 Windows x64 runner 构成；如果修改
runner 或命令，必须同时更新 YAML、相关脚本和本说明。

## CI baseline 与用户平台

`ci.yml` 每次正常 push / pull request 触发都会在 `windows-2022` 和 `windows-2025`
分别执行相同流程：`npm ci --ignore-scripts`、release/privacy audit、
`npm rebuild ffmpeg-static`、build、check、安装 fd/ripgrep 和 test。两个 job 都
必须通过；不得使用 `windows-latest`，也不应把其中一个 job 失败解释为可以跳过
另一边。

这两个 runner 是 GitHub Windows Server 的自动化验证环境，不是 MyHarness 的最终
用户支持矩阵。MyHarness 面向 Windows 桌面 x64；通过这两个 job 不能声称“只支持
Windows Server”，也不能声称已逐一验证 Windows 10/11 的每个桌面版本。桌面版本、
终端、真实 Provider、OAuth、LSP 和外部网络仍需分别标记实际验证状态。

## 维护边界

- workflow 使用的命令必须与根 `package.json`、`scripts/README.md` 和各 package 的 scripts 一致；命令改名时同步检查 YAML。
- 正式 CI 的 runner 只能是 `windows-2022` 和 `windows-2025`；禁止把 `windows-latest` 当作稳定基线。
- binary workflow 与 [`scripts/build-binaries.sh`](../../scripts/build-binaries.sh) 的平台、资源和产物名称必须保持一致。
- CI 通过只表示对应 workflow 在其实际 runner、凭据和网络条件下通过；不自动证明本机 Windows、真实 Provider、OAuth、终端或 LSP 行为。
- 不在 workflow、Issue template 或文档中写入真实 secret；可以记录 secret 名称，但不能记录 secret 值。
- Issue gate、label 和 contributor workflow 的行为以 YAML、permissions、event 和实际 GitHub run 为准。

## 本地检查与发布边界

本地可以做 YAML 静态检查、脚本语法检查、命令存在性检查和 release audit。GitHub Actions、远端权限、secret、网络、runner 平台和发布产物必须单独标记为未验证，除非确实有对应的远端 run 证据。

- [根脚本说明](../../scripts/README.md)
- [Release Gate](../RELEASE_GATE.md)
- [`.github` 维护手册](../../.github/maintenance.md)
- [后续自动化方向](../../.github/roadmap.md)
