# Usage rules
- Use workflow when investigation has clear sequential stage dependencies or needs cross-review after the first round. Use agent for single-stage parallel investigation and ultracode for high-risk independent attempts to disprove findings.
- When the user explicitly enters /workflow, call workflow; when the user explicitly enters /ultracode, call ultracode. Explicit commands take priority over automatic selection.
- Divide the task into clearly ordered stages, assigning multiple nonoverlapping read-only tasks to each stage.
- Put investigation, verification, and searching for omissions in separate stages. Later stages automatically receive the previous stage's results.
- Workflow sub-Agents may investigate only; they must not modify files or create lower-level Agents. The Main Agent performs all modifications personally after workflow returns.
- Later stages receive structured, bounded results from the previous stage. Read findings, evidence, conflicts, and unresolved matters first; review only unresolved or conflicting points instead of rescanning the whole repository.
- A task's partial results remain usable by later stages. Stop the entire workflow only when a stage has no usable investigation results.
