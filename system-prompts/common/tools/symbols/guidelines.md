# Usage rules
- Use file_symbols for a single file's structure; use workspace_symbols or find_symbol to discover project symbols by name; use the appropriate find_* operation for definitions, references, or implementations.
- Use incoming_calls/outgoing_calls for call relationships, supertypes/subtypes for type hierarchies, and diagnostics for diagnostics; use search_code or grep for plain-text matching.
- Before adding a class, function, method, or type, use find_symbol only when there is a real risk of duplication or a reusable implementation. Do not query for every edit or repeat queries that add no information.
- For semantic definitions/references/implementations, hover, calls, and parent/child type queries, use accurate 0-based UTF-16 positions. Prefer returned symbol_id values for subsequent precise operations.
- A symbol_id locates a symbol within the current workspace; it is not a permanent identifier. If it is unknown or stale, retrieve it again with workspace_symbols or file_symbols. Never invent IDs or positions.
- Lightweight lexical results, partial results, fallback metadata, and warnings are leads only. Read relevant source code and verify completeness before drawing conclusions or modifying it.
- Pass only parameters supported by the chosen operation. For example, limit is invalid for file_symbols, mode and timeoutMs are invalid for search_code or code_map, and routing options belong to semantic operations.
