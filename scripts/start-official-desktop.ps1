# Daily entry point: process-local settings, independent official data, visible app.
param([string]$PathsFile, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
if (-not $PathsFile) { $PathsFile = Join-Path $root 'config\official-desktop.paths.json' }
if (-not (Test-Path -LiteralPath $PathsFile -PathType Leaf)) {
    throw "Missing $PathsFile. Copy config\official-desktop.paths.example.json to config\official-desktop.paths.json and fill in your local paths."
}
$paths = Get-Content -LiteralPath $PathsFile -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($key in @('app','home','userData','workspace')) {
    $value = [string]$paths.$key
    if ([string]::IsNullOrWhiteSpace($value) -or $value -match '["\r\n\x00]' -or -not [IO.Path]::IsPathRooted($value)) {
        throw 'Official Desktop paths must be absolute and cannot contain quotes or control characters.'
    }
    $paths.$key = [IO.Path]::GetFullPath($value).TrimEnd('\','/')
}
$exe = Join-Path $paths.app 'DeepSeek Harness.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Official DeepSeek Harness is not installed at the configured path.' }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'The installed Node runtime is required to check this LeaderTeam installation.' }
$priorApp = [Environment]::GetEnvironmentVariable('LT_DSH_APP','Process')
try {
    $env:LT_DSH_APP = $paths.app
    $runtimeJson = & $node (Join-Path $PSScriptRoot 'dsh-runtime.mjs') --json
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the official Desktop runtime layout.' }
    $runtime = ($runtimeJson -join "`n") | ConvertFrom-Json
} finally { [Environment]::SetEnvironmentVariable('LT_DSH_APP',$priorApp,'Process') }
$version = $runtime.version
if ($runtime.kind -ne 'official-desktop' -or -not $version) { throw 'This official Desktop build has not been qualified by LeaderTeam.' }
$legacyHome = Join-Path $env:APPDATA 'dsh-desktop'
foreach ($target in @($paths.home,$paths.userData)) {
    if ($target -ieq $legacyHome -or $target.StartsWith($legacyHome + '\',[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Official Desktop must use its independent data directory.'
    }
    $ancestor = $target
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $ancestorItem = Get-Item -LiteralPath $ancestor -Force
            if (($ancestorItem.Attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Encrypted)) -ne 0) {
                throw 'An official data ancestor is linked or EFS-encrypted. Choose an ordinary local directory.'
            }
        }
        $parent = Split-Path -Parent $ancestor
        if (-not $parent -or $parent -eq $ancestor) { break }
        $ancestor = $parent
    }
}
if ($paths.home -ieq $paths.userData -or
    $paths.home.StartsWith($paths.userData+'\',[StringComparison]::OrdinalIgnoreCase) -or
    $paths.userData.StartsWith($paths.home+'\',[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Harness data and desktop data must use separate directories.'
}
$existing = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" | Where-Object {
    $_.ExecutablePath -ieq $exe -and $_.CommandLine -notmatch '(?:--type=|dsh-desktop-host|ELECTRON_RUN_AS_NODE)'
})
if ($existing.Count -gt 0) { throw 'Official Desktop is already running. Open its existing window, or quit it before starting this entry.' }
if ($DryRun) {
    [pscustomobject]@{exe=$exe;version=$version;home=$paths.home;userData=$paths.userData;workspace=$paths.workspace;writes=$false} | ConvertTo-Json
    return
}
foreach ($target in @($paths.home,$paths.userData)) {
    if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target | Out-Null }
}
if (-not (Test-Path -LiteralPath $paths.workspace -PathType Container)) { throw 'The configured workspace is unavailable.' }
# Keep the caller environment untouched and pass an explicit environment to Electron.
# This also handles callers launched from an ELECTRON_RUN_AS_NODE=1 CLI environment.
& $node (Join-Path $PSScriptRoot 'dev\launch-official-desktop.mjs') --app $paths.app --home $paths.home --user-data $paths.userData --workspace $paths.workspace
if ($LASTEXITCODE -ne 0) { throw 'Official Desktop launch failed.' }
