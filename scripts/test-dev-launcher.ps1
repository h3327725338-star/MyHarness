$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $repoRoot "dev.ps1"
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($launcherPath, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }

$source = Get-Content -LiteralPath $launcherPath -Raw
if ($source -match "Get-RequiredProviders|Test-ModelDataReady|hydrate:model-data") {
	throw "dev.ps1 still contains the removed upstream model catalog startup gate"
}
if ($source -notmatch "models\.json") {
	throw "dev.ps1 no longer documents the manual models.json Provider source"
}

Write-Host "PASS: launcher uses manual models.json Providers without an upstream catalog gate."
