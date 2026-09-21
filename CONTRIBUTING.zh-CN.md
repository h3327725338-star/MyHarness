# 为 MyHarness 贡献代码

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

MyHarness 的公开仓库地址是
<https://github.com/h3327725338-star/MyHarness>。请保持改动聚焦，保留已有
用户数据和配置格式；如果改变行为或兼容性，请在 Pull Request 中说明。

项目目前处于 Early-stage / Work in Progress。修改公共 contract 前，请先阅读
`ARCHITECTURE_AND_DEVELOPMENT.md`、`PROJECT_STATUS.md` 以及相关 package 的维护手册。
长期设计选择记录在 `docs/decisions/`。

## 本地检查

从公开仓库开始时，先执行：

```text
git clone https://github.com/h3327725338-star/MyHarness.git
cd MyHarness
```

当前项目的维护环境要求 Node.js `>=22.19.0`；Windows 上需要 Git Bash。

在仓库根目录执行：

```text
npm install
npm test
npm run check
npm run audit:release
```

`npm run check` 包含可能写入构建或 cache artifact 的 formatter 和检查。如果需要只读检查，运行更窄的 package test 或 TypeScript command，并准确报告实际执行的命令。

Windows Code Intelligence 模块不提交到仓库。修改
`packages/coding-agent/code-intelligence/runtime-manifest.json` 时，必须提供准确的 release artifact byte size 和 SHA-256。不要提交 language-server archives、credentials、Session data 或生成的 runtime directories。

打开 Pull Request 或推送 release candidate 前，运行 `npm run audit:release`。准备好的 public history 使用 `npm run audit:public`。Git hooks 会自动调用 staged/ref 版本，但 audit 不能替代对新 fixture、attribution 和外部 release asset 的检查。

MyHarness 自有代码使用 Apache-2.0。不要把第三方或继承代码改成 Apache-2.0；保留原有 notice、copyright 和 attribution；如果复制或重新分发的组件发生变化，同步更新 `THIRD_PARTY_NOTICES.md`。

## Pull Request

请说明受影响的 package、实际运行的测试，以及因为真实外部 Provider、已发布 release、或机器相关 Windows tooling 而无法运行的检查。保留无关的工作树改动，不要对共享历史执行 force-push。不要包含 `data/`、`.myharness/agent/`、`dist/`、credentials、logs、下载的 Code Intelligence modules 或本机绝对路径。
