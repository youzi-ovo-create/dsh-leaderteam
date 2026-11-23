# Runs unit tests and the installer/integration suites. The default runtime is official DSH Desktop 0.2.2-rc.1.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\run-tests.ps1 [-UnitOnly] [-Scenario it01]
param([switch]$UnitOnly, [string]$Scenario = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node (>= 22.15) was not found on PATH' }
Write-Host "node: $(& $node --version)"
& $node --test "test/unit/*.test.mjs"
if ($LASTEXITCODE -ne 0) { throw "unit tests failed ($LASTEXITCODE)" }
if ($UnitOnly) { return }
if (-not $env:LT_DSH_APP) {
  $runtimeCandidate = Join-Path $root 'runtime\official-desktop\0.2.2-rc.1'
  $pathsConfig = Join-Path $root 'config\official-desktop.paths.json'
  if (Test-Path -LiteralPath $runtimeCandidate) {
    $env:LT_DSH_APP = $runtimeCandidate
  } elseif (Test-Path -LiteralPath $pathsConfig) {
    $cfgApp = (Get-Content -LiteralPath $pathsConfig -Raw -Encoding UTF8 | ConvertFrom-Json).app
    if ($cfgApp -and (Test-Path -LiteralPath $cfgApp)) { $env:LT_DSH_APP = $cfgApp }
  }
}
& $node scripts/dsh-runtime.mjs --json
if ($LASTEXITCODE -ne 0) { throw "DSH runtime resolution failed" }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'test\desktop-backup.test.ps1')
if ($LASTEXITCODE -ne 0) { throw "backup and recovery tests failed ($LASTEXITCODE)" }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'test\install-desktop.test.ps1')
if ($LASTEXITCODE -ne 0) { throw "installer tests failed ($LASTEXITCODE)" }
& $node test/integration/desktop-provider-merge.mjs
if ($LASTEXITCODE -ne 0) { throw "provider configuration merge checks failed ($LASTEXITCODE)" }
if ($Scenario) { & $node test/integration/run.mjs $Scenario } else { & $node test/integration/run.mjs }
if ($LASTEXITCODE -ne 0) { throw "integration scenarios failed ($LASTEXITCODE)" }
Write-Host 'ALL TESTS PASSED'
