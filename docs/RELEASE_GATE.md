# MyHarness Release Gate

这是首次公开发布和后续 release candidate 的固定检查入口。它不改变
仓库可见性、不推送、不重写 `main`，也不删除本地 `data/` 或用户配置。

## 固定流程

在仓库根目录执行：

```powershell
npm.cmd install --ignore-scripts
npm.cmd run audit:release
npm.cmd run check
npm.cmd run build:offline
npm.cmd test
npm.cmd run audit:public
```

其中 `audit:public` 针对当前公开 `main` ref 使用。真实 Provider、OAuth、已发布的
Code Intelligence 归档和 Linux/macOS 行为仍需单独记录，不能由这组命令推断。

## GitHub CI baseline 与用户平台

正式 `.github/workflows/ci.yml` 固定在 `windows-2022` 和 `windows-2025` 两个
GitHub-hosted Windows x64 runner 上运行相同的完整流程；两边都必须通过，且不使用
`windows-latest`。本地 Release Gate 不能替代两个远端 job 的实际结果。

这只是 GitHub CI baseline。MyHarness 的用户平台是 Windows 桌面 x64；不能把 CI
Windows Server runner 写成“只支持 Windows Server”，也不能声称仅凭这两个 runner
已经逐一验证 Windows 10/11 的每个桌面版本。发布 binary、npm、audit 和协作
workflow 的其他 runner 仍按各自 workflow 单独记录。

Fresh checkout 验收应从公开 `main` 建立新的临时 checkout，
不复用当前 `node_modules`、`dist`、cache 或 `data`，再按 README 的安装、
check、build 和 `--help` 步骤运行。Windows 上若 PowerShell execution policy
阻止脚本，使用文档中的显式 `-ExecutionPolicy Bypass` 命令，并把它记录为
环境限制而不是产品成功证据。

## Hook 和 release 入口

- `.husky/pre-commit` 在格式化后审计 staged 内容，阻止明显的用户数据目录、
  credential 文件、私钥、真实用户路径、异常大文件和已下载 runtime 被提交。
- `.husky/pre-push` 按 Git 提供的 local commit SHA 审计完整 tree；删除远端分支
  的零 SHA 不会被误审计。
- `scripts/release.mjs` 在版本变更前运行 `npm run audit:release`，实际 push
  仍受脚本既有流程和 pre-push hook 约束；本地 Release Gate 不代表 release、publish
  或 push 已经执行或成功。

审计入口：

```powershell
npm.cmd run audit:release   # 当前 worktree 的 tracked 内容
npm.cmd run audit:staged    # index 中将要提交的内容
npm.cmd run audit:public    # 当前公开 main 的完整 tree
```

脚本只打印类别、路径和行号，不打印匹配到的值。测试和文档中的明显
synthetic 值（如 `test-secret`、`example.invalid`、`/home/user`）不会被当成
真实凭据；新 fixture 也应保持这种可识别的占位形式。审计不是完整的商业
Secret Scanner，未知的个人信息、第三方 attribution 和新类型凭据仍需人工复核。

## 匿名隐私事故登记

这里记录类别、影响和检测方法，不记录真实用户名、邮箱、token 或完整路径。

| 类别 | 发现/影响 | 当前处理与以后检测 |
| --- | --- | --- |
| 本机运行数据 | 根目录 `data/` 曾有大量 session/workspace 运行文件；它们是本地用户数据，不是源码。 | 保留在本机，不删除；`.gitignore`、staged audit 和 public-tree audit 阻止进入公开 tree。 |
| 用户级 credential/session | `.myharness/agent/`、`auth.json`、trace 和下载 runtime 属于用户目录边界。 | 由路径规则和文档约束检测；只提交源码、manifest 和 notices。 |
| 私有历史中的大型 runtime | 私有 Git/LFS 历史仍有旧 Code Intelligence 二进制；它不属于当前公开 `main`。 | 不重写私有 `main`；用 `git lfs ls-files --all --size` 和 public ref audit 分别检查历史与待公开 tree。 |
| 继承示例中的本机绝对路径 | 一个示例脚本包含具体 POSIX 用户目录样式路径，已改为 `/Users/example/...`。 | 审计 concrete `/Users/<name>`、`/home/<name>` 和 Windows user paths；fixture 使用 `user`/`example` 等明显占位名。 |
| 测试 credential-like 字符串 | Provider、redaction 和 OAuth 测试需要 synthetic key/token/header 值；它们不是真实凭据。 | 保留测试语义但使用 `test`、`secret`、`example`、`local` 等占位词；扫描器不输出值并按测试路径降噪。 |

如果未来确认真实值曾进入 commit/history：先停止 push，保存 commit/ref 证据，
撤销/轮换凭据，再按维护者批准的历史清理方案处理；不要只删除 working-tree
文件就宣称历史已清理。公开报告只写类别和受影响路径，不复制原值。

## Release 判断边界

通过本地审计只证明当前文件和 Git tree 没有被这些高置信规则拦截。公开前还要
确认：

- 根 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md` 和 package metadata 一致；
- `runtime-manifest.json` 在 `published: false` 时不伪造 hash、size 或 asset；
- public ref 不含 `data/`、`node_modules/`、dist、LFS pointer、submodule 或下载 runtime；
- fresh checkout 的失败和未验证项被记录，而不是改测试断言来制造全绿；
- 远端 visibility、push 和对应 GitHub Actions run 必须在实际操作后单独确认；本地
  Release Gate 不能替代这些结果。
