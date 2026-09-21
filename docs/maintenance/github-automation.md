# GitHub 自动化

`.github/workflows/` 中的 YAML 是 GitHub Actions 行为的事实来源；本文只提供入口、范围和维护边界，不把文档内容当作某次远端运行已经成功的证明。

## Workflow 范围

| Workflow | 作用 |
| --- | --- |
| `ci.yml` | 持续集成检查 |
| `pr-gate.yml` | Pull Request gate |
| `build-binaries.yml` | 多平台 binary 构建 |
| `npm-audit.yml` | npm 依赖审计 |
| `issue-gate.yml` | Issue gate |
| `issue-triage-labels.yml` | Issue triage label |
| `approve-contributor.yml` | 贡献者审批相关自动化 |
| `remove-inprogress-on-close.yml` | Issue 关闭后的 label 清理 |

## 维护边界

- workflow 使用的命令必须与根 `package.json`、`scripts/README.md` 和各 package 的 scripts 一致；命令改名时同步检查 YAML。
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
