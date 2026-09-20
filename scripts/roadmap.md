# scripts 后续开发边界

这是脚本层的候选方向，不是排期。以根 `package.json`、脚本源码和 CI workflow 的当前行为为准。

## 候选方向

- 为检查脚本增加明确的 read-only 入口，和会运行 `Biome --write` 或生成文件的入口分开。
- 统一跨平台的 npm、路径和退出码处理，并为 Windows PowerShell 与 Bash 分别保留可验证命令。
- 为 lockfile、shrinkwrap、版本同步和发布产物增加 source-to-output 说明及差异检查。
- 为 smoke、profile、stats 和 release 脚本补充安全的脱敏输出和失败原因分类。
- 将脚本调用图与 `.github/workflows` 的命令做静态一致性检查。

## 验收要求

新脚本必须说明是否写入源码、`dist`、lockfile、用户目录或远端服务；至少提供参数、失败退出码、平台边界和对应文档入口。没有真实发布或远端运行时，不得写成发布成功。
