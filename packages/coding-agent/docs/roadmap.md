# Coding Agent 后续开发边界

本文件描述当前源码允许的演进方向，不是已经排定的 roadmap。

## 产品装配

继续以 `main.ts`、`ResourceLoader`、`ModelRuntime`、`SessionManager` 和 `AgentSession` 为正式连接点。新跨领域流程放 `application/use-cases`，单领域规则放对应目录；不要创建万能 `core/`、`shared/` 或 `utils` 业务层。

## Provider 与 settings

继续完善 `models.json`、custom/native/extension Provider、credential、catalog cache、offline refresh 和 model resolver。任何新 Provider 体验都必须区分“可配置”“已认证”“catalog 已加载”“真实请求成功”。

## Session 与 workspace

新增 Session entry、branch、projection 或 migration 时，同时更新 JSONL format、manager、reopen/invalid-file/fork 测试；若接入 SQLite，明确产品 runtime 的真实选用状态。

## Tools、workflow、symbols

新增工具遵守 execution/presentation 分层；workflow 继续保持 read-only investigation contract；symbols 后端通过统一 API/router 接入，并公开 lightweight/semantic/runtime source。

## UI 与平台

新的 interactive mode 或 UI 先复用 `packages/tui` contract；平台适配留在 `platform`/`bun`/TUI native 边界。Windows、Bun、真实终端和外部服务要分别验证。

## 完成条件

- 更新源码模块地图和受影响专题文档；
- 更新公共 API/config/Session/Prompt 的说明；
- 有针对性测试和实际命令结果；
- 报告未执行的真实启动、外部 Provider、OAuth、LSP、binary 或桌面验证；
- 确认没有误把历史实现、生成物或 upstream 文案当作当前功能。
