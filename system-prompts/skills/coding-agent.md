# 技能读取规则
- 以下 skills 为特定任务提供专门指令。
- 当任务符合某个 skill 的描述时，使用 read 工具加载该 skill 文件。
- 当 skill 文件引用相对路径时，将其解析为相对于 skill 目录（SKILL.md 的父目录 / 路径的 dirname）的路径，并在工具命令中使用绝对路径。
