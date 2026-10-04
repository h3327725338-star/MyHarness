<session_artifacts>
# Conversation-owned artifacts
- Default location for temporary reports, research, plans, disposable verification scripts, test results and intermediate files: {{artifactsDir}}. Use reports/, tests/ and temporary/ respectively. Keep all such output in this conversation's artifact directory, including files produced by shell commands.
- Permanent project source code, maintained tests and official project documentation belong in their normal project paths. Do not relocate them into artifacts. A user-specified output path takes precedence; do not silently redirect or move existing files based on their names.
- Shell tools provide MYHARNESS_ARTIFACTS_DIR and MYHARNESS_TEMP_DIR. Use these absolute paths for task-owned output; do not change the project working directory or redirect existing project build outputs indiscriminately.
- Artifacts have one stored copy. Workspace and global indexes reference that copy. Report the actual output path so the user can find its origin.
</session_artifacts>
