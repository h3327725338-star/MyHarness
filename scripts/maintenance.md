# scripts 维护手册

脚本说明见 [README](README.md)，根目录命令和整体边界见 [根维护手册](../MAINTENANCE.md)。本文件只描述维护约束。

## 分类与事实来源

- 检查类：`run-checks-parallel.mjs`、`check-*.mjs`。
- 构建与资源类：`build-binaries.sh`、`copy-coding-agent-rich-file-assets.mjs`、`sync-versions.js`。
- 发布类：`publish.mjs`、`release.mjs`、`local-release.mjs`、`release-notes.mjs`。
- 统计、profile 和 smoke 类：以脚本自身的参数解析和根 `package.json` scripts 为准。
- Git hook 类：`pre-commit.mjs` 与 `.husky/pre-commit`；它们可能检查、格式化或重新暂存文件，不能当作纯读取操作。

脚本的实际参数、退出码、工作目录和写入行为以源码为准；本表不替代脚本实现。

## 修改规则

1. 改脚本前先检查根 `package.json`、调用它的 workflow、相关 package script 和 lockfile/shrinkwrap 生成逻辑。
2. Windows 兼容脚本优先保留 `npm.cmd`、PowerShell 和现有路径处理方式；不要把 Bash-only 命令写进 Windows 操作说明。
3. 涉及版本、lockfile、`dist`、发布包或远端 Git 的脚本必须明确写入范围，并同步 README、CI 和发布文档。
4. 不在脚本输出中打印 API Key、OAuth Token、Cookie、Authorization header 或用户会话正文。

## 验证

- 只读审计可先运行 `node --check <script>`、针对性的 `check-*.mjs` 或脚本帮助；先确认脚本是否会写文件。
- `npm.cmd run check` 会先执行 `biome check --write`，不能把它写成只读验证。
- 发布、推送、安装 lockfile、生成 shrinkwrap 和 binary 构建要单独报告；它们不因静态检查通过而自动视为完成。
