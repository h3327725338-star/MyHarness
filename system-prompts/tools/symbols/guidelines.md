# 使用规则
- 使用 file_symbols 获取单文件结构；使用 workspace_symbols 或 find_symbol 按名称发现项目符号；对于定义、引用或实现，使用相应的 find_* 操作。
- 使用 incoming_calls/outgoing_calls 获取调用关系，使用 supertypes/subtypes 获取类型层次，使用 diagnostics 获取诊断信息；纯文本匹配使用 search_code 或 grep。
- 添加 class、function、method 或 type 前，仅在确实存在复用或重复风险时使用 find_symbol；不要每次编辑都调用，也不要重复执行不会带来新信息的查询。
- 对于语义定义/引用/实现、hover、调用和父子类型查询，使用准确的 0-based UTF-16 位置；后续精确操作优先使用返回的 symbol_id。
- symbol_id 是当前 workspace 内的定位符，不是永久标识符。如果它未知或已过时，使用 workspace_symbols 或 file_symbols 重新获取；绝不要编造 id 或位置。
- 轻量词法结果、部分结果、回退元数据和警告只能作为线索；得出结论或进行修改前，读取相关源代码并确认其完整性。
- 只传入所选操作支持的参数；例如，limit 对 file_symbols 无效，mode 和 timeoutMs 对 search_code 或 code_map 无效，而路由选项属于语义操作。
