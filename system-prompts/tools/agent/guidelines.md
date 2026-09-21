# 使用规则
- 仅当单个调查阶段包含多个适合并行处理的独立方向时使用 agent；对于多阶段调查、交叉审查或高风险验证，优先使用 workflow 或 ultracode。
- 每个 Explore 任务都应有独立的调查范围，并要求返回文件路径、行号、已确认事实和开放问题。
- 当其他独立工作可以并行运行时，将 run_in_background=true；完成后会自动通知你。
- 最多使用 18 个任务，并自行综合结果；采取行动前验证关键发现。
- 不要把整个仓库或一个没有边界的主题交给单个任务。每个任务应有明确的目标、范围和停止条件。
- Agent 返回的结果包含 completed 或 partial 状态、covered scope、findings、evidence、conflicts、unresolved 和 stop reason。优先使用这些字段；不要对已覆盖范围做第二轮相同扫描。
