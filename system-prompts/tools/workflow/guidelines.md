当调查存在清晰的连续阶段依赖，或第一轮结果后需要交叉审查时，使用 workflow；单阶段并行调查使用 agent，高风险的独立反证使用 ultracode。
当用户明确输入 /workflow 时，必须调用 workflow；当用户明确输入 /ultracode 时，必须调用 ultracode；显式命令优先于自动判断。
将任务拆分为顺序清晰的阶段；每个阶段分配多个互不重叠的只读任务。
调查、验证和查找遗漏应分属不同阶段；后续阶段会自动收到前一阶段的结果。
Workflow 子 Agent 只能调查，不得修改文件或创建更低层级的 Agent。任何修改都由 Main Agent 在 workflow 返回后亲自完成。
后续阶段会收到前一阶段的结构化、有界结果。先阅读该结果中的 findings、evidence、conflicts 和 unresolved，只对未解决或冲突点做定向复核，不要重新扫描整个仓库。
一个任务的 partial 结果仍可供后续阶段使用；只有某阶段没有任何可用调查结果时才停止整个 workflow。
