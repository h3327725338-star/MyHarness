# Usage rules
- Before writing a new function, class, or helper that plausibly exists already, call find_existing with the intent in plain words (and likely names if known). Read the best candidates with read_symbol before deciding to reuse or write new code. Skip it for trivial or clearly new code, and do not repeat it when it adds nothing.
- find_existing returns candidates, not proof. Its coverage section says which languages were searched semantically and which only by text; "no candidate" means none was found in the covered files, not that the project has none.
- Once a symbol is located, prefer read_symbol over reading the whole file. If it says the source was cut, continue with the read command it gives.
- Before changing a signature, field, or other contract, run impact. Treat [references] as certain and [possible] as text matches to check; update every certain use.
- To rename a symbol across files, use rename_preview, check the plan, then apply it with apply_rename. Never rename across files with text replacement. If the preview is refused or partial, follow its reason instead of retrying the same call.
- Use file_symbols for a single file's structure and workspace_symbols to find symbols by name; use the matching operation for definitions, references, implementations, calls (incoming_calls/outgoing_calls), type hierarchies (supertypes/subtypes), and diagnostics.
- For position targets use accurate 0-based UTF-16 positions. Prefer returned symbol_id values for subsequent precise operations; they are valid only in the current workspace. If one is unknown or stale, look it up again. Never invent IDs or positions.
- Partial results, warnings, and text-only fallbacks are leads only. Read the relevant source before drawing conclusions. If symbols is unavailable or slow, continue with grep/find/read; it never blocks normal edits.
- Pass only the parameters the chosen operation supports.
