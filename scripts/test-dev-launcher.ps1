$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $repoRoot "web-runtime.ps1"
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($launcherPath, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }

$source = Get-Content -LiteralPath $launcherPath -Raw
if ($source -match "Get-RequiredProviders|Test-ModelDataReady|hydrate:model-data") {
	throw "web-runtime.ps1 still contains the removed upstream model catalog startup gate"
}
if ($source -notmatch "models\.json") {
	throw "web-runtime.ps1 no longer documents the manual models.json Provider source"
}

Write-Host "PASS: launcher uses manual models.json Providers without an upstream catalog gate."

# W163: the --console path reaches web-runtime.ps1 directly, so web-runtime.ps1
# must strip --restart (a launcher-only flag) before forwarding the args to the
# server, which rejects it as an unknown option.
$runtimeStripAnchor = '$args = @($args | Where-Object { $_ -ne "--restart" })'
if ($source -notmatch [regex]::Escape($runtimeStripAnchor)) {
	throw "web-runtime.ps1 forwards --restart to the server again"
}
$stripPos = $source.IndexOf($runtimeStripAnchor)
$forwardPos = $source.IndexOf('& node --import "./scripts/dev-fast-loader.mjs"', $stripPos)
if ($stripPos -lt 0 -or $forwardPos -lt 0 -or $stripPos -gt $forwardPos) {
	throw "web-runtime.ps1 strips --restart after forwarding the args"
}

Write-Host "PASS: web-runtime.ps1 strips launcher-only --restart before forwarding (W163)."

# W156: dev-web.ps1 must probe /api/boot before paying the Get-NetTCPConnection
# first-call cost (module autoload ~1s). Only the taskkill fallback (which needs the
# listener PID) may touch Get-NetTCPConnection.
$devWebPath = Join-Path $repoRoot "dev-web.ps1"
$devTokens = $null
$devParseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($devWebPath, [ref]$devTokens, [ref]$devParseErrors) | Out-Null
if ($devParseErrors.Count -gt 0) { throw ($devParseErrors | Out-String) }

$devSource = Get-Content -LiteralPath $devWebPath -Raw
$branchPos = $devSource.IndexOf('if ($port -ne 0 -and (Test-ExistingInstance $port)) {')
if ($branchPos -lt 0) { throw "dev-web.ps1 no longer probes Test-WebReady before the port-occupancy check" }
if ($devSource -notmatch '\}\s*elseif\s*\(\$port\s*-ne\s*0\s*-and\s*\(Test-PortBusy\s*\$port\)\)\s*\{\s*') {
	throw "dev-web.ps1 lost the Test-PortBusy occupancy check after the readiness probe"
}
# The startup branch itself (readiness probe -> occupancy check -> launch) must not
# call Get-PortListener/Get-NetTCPConnection: that first call costs ~1s of module
# autoload on every launch. Only the taskkill fallback needs the listener PID.
$branchEnd = $devSource.IndexOf('New-Item -ItemType Directory -Force -Path $LogDir', $branchPos)
if ($branchEnd -lt 0) { throw "dev-web.ps1 launch block anchor not found" }
$branch = $devSource.Substring($branchPos, $branchEnd - $branchPos)
if ($branch -match "Get-PortListener|Get-NetTCPConnection") {
	throw "dev-web.ps1 calls Get-PortListener/Get-NetTCPConnection in the startup branch again"
}
if (([regex]::Matches($devSource, "Get-PortListener")).Count -ne 2) {
	throw "dev-web.ps1 calls Get-PortListener outside the taskkill fallback again"
}

Write-Host "PASS: dev-web.ps1 probes readiness before Get-NetTCPConnection (W156)."

# W157/W163: the freshness decision (wake / keep / restart) lives in
# Get-InstanceDecision and is shared by the normal path, --no-open, and the
# second-chance probe. --no-open must NOT bypass it with a direct exit:
# fresh means keep (silent exit, no wake call), stale means restart.
# --restart stays launcher-only (stripped from the forwarded args; the server
# rejects it as unknown).
if ($devSource -notmatch 'Invoke-InstanceWake \$existingPort') {
	throw "dev-web.ps1 lost the wake call in the existing-instance branch"
}
$decisionFnStart = $devSource.IndexOf('function Get-InstanceDecision(')
$decisionFnEnd = $devSource.IndexOf('$existingPort = 0', $decisionFnStart)
if ($decisionFnStart -lt 0 -or $decisionFnEnd -lt 0) { throw "dev-web.ps1 freshness decision function anchors not found" }
$decisionFn = $devSource.Substring($decisionFnStart, $decisionFnEnd - $decisionFnStart)
foreach ($anchor in @('Get-BootStartedAtMs', 'Get-BackendMaxMtimeMs', 'startedAtMs', '"keep"', '"wake"', '"restart"')) {
	if ($decisionFn -notmatch [regex]::Escape($anchor)) { throw "dev-web.ps1 decision function lost: $anchor" }
}
if ($devSource -match 'if \(\$noOpen -and -not \$forceRestart\) \{ exit 0 \}') {
	throw "dev-web.ps1 --no-open bypasses the freshness decision again"
}
# The existing-instance tail (decision -> wake / keep / restart) must call the
# shared function and keep the wake call inside it.
$tailStart = $devSource.IndexOf('if ($existingPort -ne 0) {')
$tailEnd = $devSource.IndexOf('New-Item -ItemType Directory -Force -Path $LogDir', $tailStart)
if ($tailStart -lt 0 -or $tailEnd -lt 0) { throw "dev-web.ps1 existing-instance tail anchors not found" }
$tail = $devSource.Substring($tailStart, $tailEnd - $tailStart)
foreach ($anchor in @('Get-InstanceDecision $existingPort $probeTimeoutMs', 'Invoke-InstanceWake', 'Stop-ExistingInstance $existingPort')) {
	if ($tail -notmatch [regex]::Escape($anchor)) { throw "dev-web.ps1 existing-instance tail lost: $anchor" }
}
if ($devSource -notmatch '\$forward\s*=\s*@\(\$forward\s*\|\s*Where-Object\s*\{\s*\$_\s*-ne\s*"--restart"\s*\}\)') {
	throw "dev-web.ps1 forwards --restart to the server again"
}

Write-Host "PASS: dev-web.ps1 wakes an unchanged instance and keeps --restart launcher-only (W157)."

# W163 second chance: the occupancy branch must re-probe /api/boot with a
# longer timeout before reporting "occupied by another program", and must not
# grow wake/shutdown logic of its own (the shared tail handles that).
$occupiedStart = $devSource.IndexOf('} elseif ($port -ne 0 -and (Test-PortBusy $port)) {')
$occupiedEnd = $devSource.IndexOf('if ($existingPort -ne 0) {', $occupiedStart)
if ($occupiedStart -lt 0 -or $occupiedEnd -lt 0) { throw "dev-web.ps1 occupancy branch anchors not found" }
$occupiedBranch = $devSource.Substring($occupiedStart, $occupiedEnd - $occupiedStart)
if ($occupiedBranch -notmatch 'Test-ExistingInstance \$port 2000') {
	throw "dev-web.ps1 lost the second-chance probe in the occupancy branch"
}
if ($occupiedBranch -match "Invoke-InstanceWake|Get-BootStartedAtMs|Get-BackendMaxMtimeMs|Stop-ExistingInstance|Get-InstanceDecision") {
	throw "dev-web.ps1 wake logic leaked into the occupancy branch"
}
$secondChancePos = $occupiedBranch.IndexOf('Test-ExistingInstance $port 2000')
$occupiedErrorPos = $occupiedBranch.IndexOf('Show-Error')
if ($secondChancePos -lt 0 -or $occupiedErrorPos -lt 0 -or $secondChancePos -gt $occupiedErrorPos) {
	throw "dev-web.ps1 reports occupancy before the second-chance probe"
}
# The readiness probes take a timeout (default 150ms keeps every existing
# caller fast); the second-chance probe passes a longer one.
foreach ($anchor in @('function Test-WebReady([int]$Port, [int]$TimeoutMs = 150)', 'function Test-ExistingInstance([int]$Port, [int]$TimeoutMs = 150)', 'function Get-BootStartedAtMs([int]$Port, [int]$TimeoutMs = 150)')) {
	if ($devSource -notmatch [regex]::Escape($anchor)) { throw "dev-web.ps1 probe lost its timeout parameter: $anchor" }
}

Write-Host "PASS: dev-web.ps1 routes --no-open through the freshness decision and re-probes a busy port (W163)."
