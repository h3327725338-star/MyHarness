# GitHub 自动化说明

`.github/` 当前主要由 workflow、issue template 和贡献者标记组成。workflow 是 CI/发布事实来源，本文件不替代 YAML。

维护规则见 [maintenance.md](maintenance.md)，后续开发边界见 [roadmap.md](roadmap.md)。

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

## 维护规则

- workflow 中使用的命令必须与根 `package.json`、`scripts/README.md` 和 package scripts 一致；命令改名时同步检查 YAML。
- binary workflow 与 `scripts/build-binaries.sh` 的平台、资源、产物名称必须保持一致。
- CI 通过只表示该 workflow 在其实际 runner、凭据和网络条件下通过；不证明本机 Windows、真实 Provider、OAuth、终端或 LSP 行为。
- 不在 workflow、issue template 或文档中写入真实 secret；secret 名称可以记录，secret 值不可以记录。
- 变更 workflow 后应做 YAML/静态检查，并在最终报告中说明未运行的外部 GitHub Actions 部分。
