---
description: worker 负责实现，reviewer 负责审查，worker 根据反馈进行修改
---
使用 subagent 工具的 chain 参数执行以下工作流：

1. 首先，使用 "worker" agent 实现：$@
2. 然后，使用 "reviewer" agent 审查上一步的实现（使用 {previous} 占位符）
3. 最后，使用 "worker" agent 根据审查反馈进行修改（使用 {previous} 占位符）

以 chain 方式执行，并通过 {previous} 在各步骤之间传递输出。
