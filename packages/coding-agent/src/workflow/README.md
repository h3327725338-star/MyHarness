# workflow/ — 多阶段只读调查

## 说明

### 职责

实现 `workflow` 和 `ultracode` 两个工具背后的同一个执行引擎：按顺序执行若干阶段，每个阶段并行运行多个只读的 Explore 子任务，后一阶段自动拿到前一阶段的结果。

| 文件 | 内容 |
| --- | --- |
| `engine.ts` | 输入 schema、阶段编排、阶段/整体超时、取消、进度明细、结果汇总；`createWorkflowToolDefinition()` 和 `createUltracodeToolDefinition()`；运行期控制 `WorkflowToolControls`（终止单个任务或整个 workflow） |
| `tool.ts` | 出口（原样导出 `engine.ts`） |

子任务本身由 `tools/sub-agent.ts` 的 `runExploreBatch()` 运行；两种工具的差异（名称、最少阶段数、说明）来自 `ultracode/profile.ts`。

### 依赖

- 依赖：`tools/sub-agent.ts`、`tools/contracts`、`tools/tool-definition-wrapper.ts`、`tools/tool-result-persistence.ts`、`ultracode/profile.ts`、`observability/runtime-trace.ts`。
- 被依赖：`tools/registry.ts`（登记工具）、`tools/presentation/workflow.ts`（展示）、`agent/runtime`（保存运行期控制句柄）、`modes/interactive`。

## 维护

- 子任务必须保持只读：不能修改文件，也不能再创建子 Agent。这个约束由 `tools/sub-agent.ts` 的工具白名单和 `tools/shell/read-only-guard.ts` 执行，改引擎时不要绕开。
- 执行和展示分开：进度的数据结构在 `engine.ts`，怎么画在 `tools/presentation/workflow.ts`。
- 主任务结束或被取消时，`AgentSession` 会通过 `WorkflowToolControls.killWorkflow()` 结束仍在运行的 workflow；新增控制能力时保持这条取消路径。
- 相关测试：`workflow.test.ts`、`sub-agent.test.ts`、`test/suite/background-task-cascade.test.ts`。
