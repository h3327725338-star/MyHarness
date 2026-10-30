#!/usr/bin/env bash
# Starts evaluation copy A (Electron desktop app from the local source; Nebius Token Factory only), DevTools on 9353/9354,
# without taking the focus or showing on screen (quiet.mjs moves every window off screen before it first shows).
L=C:/eval/labA
cd /c/myharness || exit 1
export MYHARNESS_CODING_AGENT_DIR=$L/agent MYHARNESS_DATA_ROOT=$L/data MYHARNESS_TEMP_DIR=$L/tmp MYHARNESS_ARTIFACTS_DIR=$L/artifacts MYHARNESS_DESKTOP_CWD=$L/Documents
# Nobody sits at this copy: a site's human check stays in a headless browser instead of a window in front of the user.
export MYHARNESS_TARGETED_BROWSER_E2E=1
unset ELECTRON_RUN_AS_NODE
node C:/eval/harness/quiet.mjs > $L/quiet.log 2>&1 &
exec packages/desktop/node_modules/electron/dist/electron.exe --inspect=9354 --remote-debugging-port=9353 C:/myharness/packages/desktop --autostart > $L/desktop.log 2>&1
