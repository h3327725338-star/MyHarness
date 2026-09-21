# `.github` 维护手册

workflow 总览见[根目录的 GitHub 自动化维护文档](../docs/maintenance/github-automation.md)，根脚本边界见 [scripts/maintenance.md](../scripts/maintenance.md)。YAML、Issue template 和 GitHub 实际执行结果分别是不同证据。

## 正式 CI baseline

`.github/workflows/ci.yml` 的 `build-check-test` job 使用固定 matrix：

- `windows-2022`
- `windows-2025`

两边都是 GitHub-hosted Windows x64 runner，每次正常 push / pull request 触发都
执行相同的 `npm ci --ignore-scripts`、release/privacy audit、`ffmpeg-static`
rebuild、build、check、fd/ripgrep 安装和 test 流程；两边必须同时通过。不得使用
`windows-latest`，也不在这条正式 CI baseline 中加入 Linux/macOS job。

这是 GitHub Windows Server 自动化 baseline，不是用户平台支持矩阵。MyHarness 面向
Windows 桌面 x64；不能据此写成“只支持 Windows Server”，也不能声称已经逐一验证
Windows 10/11 的每个桌面版本。其他 release、audit、binary 和协作 workflow 的
runner 只代表各自的自动化用途。

## 修改规则

- 修改 workflow 前先核对根 `package.json`、`scripts/` 和各 package 的 scripts；命令、Node/npm 版本、产物路径和缓存键要保持一致。
- 修改 binary workflow 时同时核对 `scripts/build-binaries.sh`、平台矩阵、资源复制和产物命名。
- Secret 只记录名称或引用关系，不记录值；日志、artifact 和错误信息也不得泄露凭据。
- Issue gate、label 和 contributor workflow 的行为以 YAML、permissions、event 和实际 GitHub run 为准，不以 README 推断成功。
- workflow 变更只更新受影响的说明；不要把历史 workflow 的行为写成当前能力。
- 可由机器判断的 runner、命令和 gate 约束应直接写入 workflow 或检查脚本；文档和 Agent Prompt 只提供维护入口与边界说明。

## 验证

本地可做 YAML 静态检查、脚本语法检查和命令存在性检查；GitHub Actions、远端权限、secret、网络、runner 平台和发布产物必须单独标记为未验证，除非确实有对应 run 证据。
