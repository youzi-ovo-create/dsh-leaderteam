# Removes the LeaderTeam block from the DeepSeek Harness Desktop profile patch (keeps everything else).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\uninstall-desktop.ps1 [-DshHome <path>] [-Profile <name>]
param(
    [string]$DshHome,
    [string]$Profile = 'desktop',
    [string]$DshApp
)
$ErrorActionPreference = 'Stop'

# 0. Parameter validation
if ($Profile -notmatch '^[a-zA-Z0-9_\-]+$') {
    throw "Invalid profile name '$Profile': must contain only alphanumeric characters, underscores, and hyphens without path traversal."
}

$root = Split-Path -Parent $PSScriptRoot
$pathsFile = Join-Path $root 'config\official-desktop.paths.json'
$officialPaths = $null
if (Test-Path -LiteralPath $pathsFile -PathType Leaf) {
    $officialPaths = Get-Content -LiteralPath $pathsFile -Raw -Encoding UTF8 | ConvertFrom-Json
}
$defaultDshHome = if ($env:DSH_HOME) { $env:DSH_HOME } elseif ($officialPaths) { [string]$officialPaths.home } else { '' }
if (-not $DshApp -and $officialPaths) { $DshApp = [string]$officialPaths.app }
$isDefaultTarget = $false
if (-not $DshHome) {
    if (-not $defaultDshHome) {
        throw 'Missing config\official-desktop.paths.json: copy config\official-desktop.paths.example.json to config\official-desktop.paths.json and set your local paths, or pass -DshHome.'
    }
    $DshHome = $defaultDshHome
    $isDefaultTarget = $true
} elseif ($defaultDshHome) {
    try {
        $resolvedCurrent = [System.IO.Path]::GetFullPath($DshHome).TrimEnd('\', '/')
        $resolvedDefault = [System.IO.Path]::GetFullPath($defaultDshHome).TrimEnd('\', '/')
        if ($resolvedCurrent -ieq $resolvedDefault) {
            $isDefaultTarget = $true
        }
    } catch {}
}

$processName = if ($Profile -eq 'web') { 'DSH Desktop' } else { 'DeepSeek Harness' }
# Fixture homes under this project's own test-work directory are never loaded by a running Desktop.
$ltTestWork = [System.IO.Path]::GetFullPath((Join-Path $root 'test-work')).TrimEnd('\', '/') + '\'
$ltTargetHome = [System.IO.Path]::GetFullPath($DshHome).TrimEnd('\', '/') + '\'
$isTestFixtureHome = $ltTargetHome.StartsWith($ltTestWork, [System.StringComparison]::OrdinalIgnoreCase)
if ((-not $isTestFixtureHome) -and (Get-Process -Name $processName -ErrorAction SilentlyContinue)) {
    throw 'DeepSeek Harness Desktop is running: quit it completely and retry'
}

$patchFile = Join-Path $DshHome "profiles\$Profile\cordis.patch.yml"
$begin = '# >>> leaderteam (managed by scripts/install-desktop.ps1; do not edit inside)'
$end = '# <<< leaderteam'

if (-not (Test-Path -LiteralPath $patchFile)) {
    Write-Host "nothing to remove: $patchFile does not exist"
    return
}
$current = Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8
if ($current -notmatch [regex]::Escape($begin)) {
    Write-Host "nothing to remove: no leaderteam block found in $patchFile"
    return
}
$beginIdx = $current.IndexOf($begin, [System.StringComparison]::Ordinal)
$endIdx = if ($beginIdx -ge 0) { $current.IndexOf($end, $beginIdx + $begin.Length, [System.StringComparison]::Ordinal) } else { -1 }
if ($beginIdx -ge 0 -and $endIdx -lt 0) {
    throw "Corrupted LeaderTeam marker block in $patchFile (missing end marker). No files were changed."
}
$before = $current.Substring(0, $beginIdx).TrimEnd()
$innerStart = $beginIdx + $begin.Length
$managedBody = $current.Substring($innerStart, $endIdx - $innerStart).Trim()
$after = $current.Substring($endIdx + $end.Length).TrimStart("`r", "`n").TrimEnd()
$stripped = (@($before, $after) | Where-Object { $_ }) -join "`n"

# Rescue any non-LeaderTeam entries that Official Desktop UI appended before the trailing marker.
$rescuedPrefix = $null
$nodeCmd = (Get-Command node -ErrorAction SilentlyContinue).Source
$locatorScript = Join-Path $PSScriptRoot 'dsh-runtime.mjs'
if ($nodeCmd -and (Test-Path -LiteralPath $locatorScript -PathType Leaf)) {
    $locatorArgs = @($locatorScript, '--json')
    if ($DshApp) {
        $appDir = if (Test-Path -LiteralPath $DshApp -PathType Leaf) { Split-Path -Parent ([System.IO.Path]::GetFullPath($DshApp)) } else { $DshApp }
        $locatorArgs += @('--app', $appDir)
    }
    $prevErrPref = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $locatorOut = & $nodeCmd @locatorArgs 2>&1
        $locatorExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevErrPref
    }
    if ($locatorExit -eq 0) {
        try { $rt = (($locatorOut | Out-String).Trim()) | ConvertFrom-Json } catch { $rt = $null }
        if ($rt -and $rt.exe -and $rt.moduleRoot -and (Test-Path -LiteralPath ([string]$rt.exe) -PathType Leaf)) {
            $mergeScript = Join-Path $root 'scripts\dev\merge-desktop-provider.cjs'
            $mergeStart = New-Object System.Diagnostics.ProcessStartInfo
            $mergeStart.FileName = [System.IO.Path]::GetFullPath([string]$rt.exe)
            $mergeStart.Arguments = '"' + $mergeScript + '" "' + [System.IO.Path]::GetFullPath([string]$rt.moduleRoot) + '"'
            $mergeStart.UseShellExecute = $false
            $mergeStart.CreateNoWindow = $true
            $mergeStart.RedirectStandardInput = $true
            $mergeStart.RedirectStandardOutput = $true
            $mergeStart.RedirectStandardError = $true
            $mergeStart.StandardOutputEncoding = [System.Text.Encoding]::UTF8
            $mergeStart.StandardErrorEncoding = [System.Text.Encoding]::UTF8
            $mergeStart.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
            $mergeProcess = New-Object System.Diagnostics.Process
            $mergeProcess.StartInfo = $mergeStart
            try {
                if ($mergeProcess.Start()) {
                    $mergeInput = @{mode='uninstall'; existing=$stripped; managed=$managedBody} | ConvertTo-Json -Compress -Depth 8
                    $mergeProcess.StandardInput.Write($mergeInput)
                    $mergeProcess.StandardInput.Close()
                    $mergeOutput = $mergeProcess.StandardOutput.ReadToEnd()
                    $null = $mergeProcess.StandardError.ReadToEnd()
                    $mergeProcess.WaitForExit()
                    if ($mergeProcess.ExitCode -eq 0) {
                        $unmerged = $mergeOutput | ConvertFrom-Json
                        $rescuedPrefix = [string]$unmerged.prefix
                    }
                }
            } finally { $mergeProcess.Dispose() }
        }
    }
}
if ($null -ne $rescuedPrefix) {
    $newText = $rescuedPrefix.TrimEnd() + "`n"
} else {
    $newText = $stripped.TrimEnd() + "`n"
    $newText = [regex]::Replace($newText, '(?m)^# leaderteam-original-empty-array: ([A-Za-z0-9+/=]+)\r?$', {
        param($match)
        [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($match.Groups[1].Value))
    })
}
$patchDir = Split-Path -Parent $patchFile
$tmpFile = Join-Path $patchDir (".tmp-patch-" + [System.Guid]::NewGuid().ToString('N'))
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tmpFile, $newText, $utf8NoBom)
if ([System.IO.File]::Exists($patchFile)) {
    [System.IO.File]::Replace($tmpFile, $patchFile, [NullString]::Value)
} else {
    [System.IO.File]::Move($tmpFile, $patchFile)
}
Write-Host "removed the LeaderTeam block from $patchFile"
