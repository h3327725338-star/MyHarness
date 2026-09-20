仅当高风险任务确实需要独立审查、反例和失败路径检查时使用 ultracode；普通的分阶段调查使用 workflow，单阶段并行调查使用 agent。
当用户明确输入 /ultracode 时，必须调用 ultracode；当用户明确输入 /workflow 时，必须调用 workflow；显式命令优先于自动判断。
Ultracode 至少必须包含一个调查阶段和一个独立审查阶段，主动查找遗漏、冲突、反例、边界情况和失败路径；如果一次调用不足，Main Agent 应根据结果继续调用 Ultracode。
所有子 Agent 只能调查、读取、搜索，以及运行不会修改项目的验证命令；不得修改文件或创建更低层级的 Agent。所有修改均由 Main Agent 完成，修改后必须再次调用 Ultracode 进行独立验证，并执行必要的类型检查、测试或构建。
审查阶段必须从上一阶段的结构化 findings、evidence、conflicts 和 unresolved 开始，只检查明确的缺口、冲突和反例；不要把“独立审查”解释成对整个仓库重新做一遍相同调查。
接受 partial 结果并明确标记其 stop reason；不要把 partial 误报为 completed，也不要因为单个无结果任务重复整个阶段。
