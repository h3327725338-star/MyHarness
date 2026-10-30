#!/usr/bin/env bash
# Starts a headless evaluation copy (the Web UI server from the local source, no window): start-web.sh <labDir> <port> [attended]
# With "attended" someone is at the PC: a human check opens a visible browser window for them to pass.
L=$1; P=$2
cd /c/myharness || exit 1
export MYHARNESS_CODING_AGENT_DIR=$L/agent MYHARNESS_DATA_ROOT=$L/data MYHARNESS_TEMP_DIR=$L/tmp MYHARNESS_ARTIFACTS_DIR=$L/artifacts
[ "$3" = attended ] || export MYHARNESS_TARGETED_BROWSER_E2E=1
export MYHARNESS_PROCESS_ENTRY=packages/coding-agent/src/web.ts
cd $L/Documents || exit 1
exec node --import file:///C:/myharness/scripts/dev-fast-loader.mjs C:/myharness/packages/coding-agent/src/web.ts --approve --port $P --no-open --no-extensions --no-context-files ${MYHARNESS_EVAL_ARGS:-} > $L/server.log 2>&1
