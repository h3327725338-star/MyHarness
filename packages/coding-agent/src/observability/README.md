# observability/ — 运行追踪、用量与脱敏

## 说明

### 职责

记录“发生了什么、花了多少”，并保证写出去的诊断信息不含敏感数据。它只观察，不保存业务状态。

| 文件 | 内容 |
| --- | --- |
| `runtime-trace.ts` | `RuntimeTrace`：把一次运行的事件写成 `traces/<session>/<run>.jsonl`；工具参数和结果只记摘要 |
| `session-trace.ts` | `AgentSessionTraceCoordinator`：把 `AgentSession` 的事件映射成追踪记录，维护当前/上一次运行的 scope |
| `usage-totals.ts` | 用量与费用累计 |
| `session-stats.ts` | `collectSessionUsageStats()`：统计一个会话全部条目（含已被压缩掉的历史）的消息数、工具调用数、Token 和费用 |
| `cache-stats.ts` | Prompt 缓存未命中的检测与浪费估算 |
| `diagnostic-sanitizer.ts` | 诊断文本脱敏（API Key、Token、Cookie 等），支持流式 |
| `telemetry.ts` | 安装遥测开关 |
| `timings.ts` | 启动耗时打点（`MYHARNESS_TIMING=1`） |

### 依赖

- 依赖：`session/types.ts`、`config/settings`。
- 被依赖：`agent/runtime`、`application`、`extensions/loader`、`modes/interactive`、`providers/runtime`、`tools`、`workflow`、`main.ts`。

## 维护

- Trace 与 Session JSONL 是两套数据：Trace 用于排查，不参与会话恢复，不要把业务状态塞进 Trace。
- 任何写入磁盘或显示给用户的诊断文本都要先经过 `diagnostic-sanitizer.ts`；新增敏感模式时加测试。
- `session-trace.ts` 不依赖界面；`test/phase3-architecture.test.ts` 会检查。
- 相关测试：`runtime-trace.test.ts`、`agent-session-runtime-trace.test.ts`、`cache-stats.test.ts`、`cache-stability.test.ts`、`agent-session-stats.test.ts`。
