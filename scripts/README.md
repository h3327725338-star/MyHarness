# 仓库脚本说明与维护

`scripts/` 里的脚本服务于检查、构建、发布、统计和本地启动。脚本的真实行为以脚本源码和根 `package.json` 为准；本文件只提供导航和写入边界。

维护规则见 [maintenance.md](maintenance.md)，后续开发边界见 [roadmap.md](roadmap.md)。

## 检查脚本

| 脚本 | 作用 | 默认写入 |
| --- | --- | --- |
| `run-checks-parallel.mjs` | 并行运行 pinned deps、TS imports、shrinkwrap、install-lock、`tsgo` 和 browser smoke | 子进程缓存/构建产物可能更新 |
| `check-pinned-deps.mjs` | 检查仓库外部依赖是否使用精确版本；不扫描根 `data/` 运行时数据目录 | 否 |
| `check-ts-relative-imports.mjs` | 检查 `.ts` 中相对 `.js` import | 否 |
| `check-browser-smoke.mjs` | 运行 browser smoke 检查 | 由 smoke 运行决定 |
| `generate-coding-agent-shrinkwrap.mjs` | 生成或 `--check` 校验发布 shrinkwrap；不带 `--check` 会写文件 | 是（不带 `--check`） |
| `generate-coding-agent-install-lock.mjs` | 生成或 `--check` 校验独立安装 lock；不带 `--check` 会写目录文件 | 是（不带 `--check`） |
| `check-lockfile-commit.mjs` | 提交前阻止不符合锁文件约束的状态 | 否 |
| `release-audit.mjs` | 检查 staged 文件、当前 tracked tree 或指定 Git ref 的路径、凭据模式、用户路径、运行时产物、License 和 manifest；staged 模式还检查整个 index 中是否残留 Agent/Harness/IDE 本地状态目录 | 否 |

依赖检查的扫描边界回归测试：`node --test scripts/check-pinned-deps.test.mjs`。

`npm run check` 先执行 `biome check --write`，再调用 `run-checks-parallel.mjs`；不要在自动化中把它当作纯诊断命令。

## 构建、测试和性能

- `build-binaries.sh` 使用 Bun 编译多平台 binary，并打包 docs、examples、system-prompts、assets 和 native bindings；它会清理指定的 binary 输出目录。
- `profile-coding-agent-node.mjs` 测量 Node/Bun 启动路径，可选择 profile 目录和 CPU profile；性能数值只有在实际运行后才成立。
- `agent-treeshake-smoke-entry.ts` 和 `browser-smoke-entry.ts` 是针对构建/runtime 边界的入口，不等于普通单元测试。Code Intelligence 的安装状态由 `packages/coding-agent/test/code-intelligence/runtime-manager.test.ts` 覆盖；真实语言服务器 E2E 需要已发布且有完整校验元数据的 Windows 归档。
- `dev-fast-loader.mjs` 是 `web-runtime.ps1` 用 `node --import` 加载的解析器：按根 `tsconfig.json` 的 `@myharness/*` paths 把 workspace 包指向源码，配合 Node 原生类型剥离运行 TypeScript（不经过 tsx）。它只读文件，不用于测试和构建。
- `test-dev-launcher.ps1`、`repro-5893-wsl-bash.mjs` 等脚本是开发/回归工具，执行前先阅读参数和目标目录。

## 发布和版本

| 脚本 | 作用 |
| --- | --- |
| `sync-versions.js` | 检查 workspace lockstep version，并更新内部依赖版本；会写 package.json |
| `release.mjs` | 执行版本、构建/检查和 release 流程 |
| `local-release.mjs` | 本地发布流程 |
| `build-code-intelligence-artifacts.mjs` | 构建 Code Intelligence 语言模块和共享运行环境的 Windows 发布包：从 npm 和各语言服务器上游下载，输出到 `.artifacts/code-intelligence/`（已被 Git 忽略，下载缓存 `downloads/`、中间目录 `work/`、成品 `release/`）；`--only id,id` 只构建指定项；`--apply` 把成品的真实大小和 SHA-256 写进 `runtime-manifest.json` 并置 `published: true`；Ruby 模块需要环境变量 `MSYS2_PATH` 指向带 gcc 的 MSYS2 / RubyInstaller DevKit；会访问外部网络，不上传任何东西 |
| `publish.mjs` | 发布或 dry-run 发布 |
| `release-notes.mjs` | 修复/生成 release notes 相关链接 |
| `pre-commit.mjs` | 将 Biome 修改过且仍存在的已暂存文件重新加入 index |

常用发布前命令：

```powershell
npm.cmd run audit:release
npm.cmd run audit:public
```

`.husky/pre-commit` 审计 staged 文件内容及整个 index 中的禁止路径；`.husky/pre-push` 按待推送 commit
审计完整 tree，包括已跟踪的 Agent/Harness/IDE 本地状态目录；`release.mjs` 在版本变更前执行 worktree 审计。审计只输出
类别、路径和行号，不输出匹配到的 credential 或个人值。测试中的明确
synthetic fixture（例如 `test-secret`、`example.invalid`）不会被当成真实
凭据；它们仍需保持明显为测试值。

版本、发布、shrinkwrap、install lock 和 binary 脚本都属于写入操作。不要在未确认工作区和发布目标前加 `--force` 或清理输出。

## 维护规则

- 新脚本先添加到根 `package.json` 或对应 workflow 的明确入口，避免只能靠 undocumented 参数运行。
- 脚本涉及 workspace、lockfile、dist、binary、用户目录或外部网络时，在本文件和脚本帮助文本中说明写入范围。
- 任何脚本输出都必须脱敏，不打印 credential、token、cookie 或完整 authorization header。
- 修改脚本后至少做静态语法检查；真实 build、publish、binary 和外部 smoke 必须单独报告是否执行。
