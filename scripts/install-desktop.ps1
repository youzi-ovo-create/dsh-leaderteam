# Installs (or updates) the LeaderTeam rows and Magpie provider into the official DeepSeek Harness Desktop profile, idempotently, with a backup.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install-desktop.ps1 [-DryRun] [-DshHome <path>] [-Profile <name>] [-DshApp <path>]
# Requires: DeepSeek Harness 0.2.2-rc.1 installed and FULLY QUIT. Reversible with scripts\uninstall-desktop.ps1.
param(
    [switch]$DryRun,
    [string]$DshHome,
    [string]$Profile = 'desktop',
    [string]$DshApp,
    [string]$MagpieBaseUrl = 'http://127.0.0.1:3425/v1',
    [string]$BackupDir
)
$ErrorActionPreference = 'Stop'

# 0. Parameter validation
if ($Profile -notmatch '^[a-zA-Z0-9_\-]+$') {
    throw "Invalid profile name '$Profile': must contain only alphanumeric characters, underscores, and hyphens without path traversal."
}

if ($MagpieBaseUrl -match '[\s\x00-\x1f\x7f]') {
    throw 'Invalid -MagpieBaseUrl: whitespace and control characters are not allowed.'
}
try {
    $parsedUri = [System.Uri]$MagpieBaseUrl
} catch {
    throw 'Invalid -MagpieBaseUrl: must be a valid URI.'
}
if ($parsedUri.Scheme -notin @('http', 'https')) {
    throw 'Invalid -MagpieBaseUrl: scheme must be http or https.'
}
if (-not $parsedUri.IsLoopback) {
    throw 'Invalid -MagpieBaseUrl: host must be a loopback address (e.g. 127.0.0.1 or localhost).'
}
if ($parsedUri.UserInfo) {
    throw 'Invalid -MagpieBaseUrl: embedded credentials (userInfo) are not allowed.'
}
$MagpieBaseUrl = $parsedUri.AbsoluteUri

$root = Split-Path -Parent $PSScriptRoot
$fwdRoot = $root -replace '\\', '/'
$rootUrl = ([System.Uri]($root + [System.IO.Path]::DirectorySeparatorChar)).AbsoluteUri.TrimEnd('/')

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
        throw 'Missing config\official-desktop.paths.json: copy config\official-desktop.paths.example.json to config\official-desktop.paths.json and set your local paths, or pass -DshHome and -DshApp.'
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

# 1. Runtime & Version verification via locator (strictly require official 0.2.2-rc.1 by default; legacy 0.13.2 only when explicitly passed via -DshApp)
$locatorScript = Join-Path $PSScriptRoot 'dsh-runtime.mjs'
$nodeCmd = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeCmd) {
    throw 'Node.js runtime is required to resolve the DeepSeek Harness runtime.'
}

$appDirToResolve = $null
if ($DshApp) {
    if (Test-Path -LiteralPath $DshApp -PathType Leaf) {
        $appDirToResolve = Split-Path -Parent ([System.IO.Path]::GetFullPath($DshApp))
    } else {
        $appDirToResolve = $DshApp
    }
}

$locatorArgs = @($locatorScript, '--json')
if ($appDirToResolve) {
    $locatorArgs += @('--app', $appDirToResolve)
}
$prevErrPref = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $locatorOut = & $nodeCmd @locatorArgs 2>&1
    $locatorExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $prevErrPref
}
if ($locatorExit -ne 0) {
    $locatorErr = ($locatorOut | Out-String).Trim()
    throw "Official DeepSeek Harness version 0.2.2-rc.1 required, but runtime verification failed: $locatorErr"
}
try {
    $runtime = (($locatorOut | Out-String).Trim()) | ConvertFrom-Json
} catch {
    throw 'Official DeepSeek Harness version 0.2.2-rc.1 required, but runtime locator returned invalid JSON.'
}

$isSupportedOfficial = ($runtime.kind -eq 'official-desktop' -and $runtime.version -eq '0.2.2-rc.1')
$isSupportedExplicitLegacy = ([bool]$DshApp -and $runtime.kind -eq 'legacy-dataelem' -and $runtime.version -eq '0.13.2')
if (-not ($isSupportedOfficial -or $isSupportedExplicitLegacy)) {
    throw "Official DeepSeek Harness version 0.2.2-rc.1 required, but found kind='$($runtime.kind)' version='$($runtime.version)'. Installation aborted."
}

$desktopExe = [string]$runtime.exe
$moduleRoot = [string]$runtime.moduleRoot
if (-not $desktopExe -or -not $moduleRoot) {
    throw 'Desktop executable and moduleRoot are required for local configuration merging.'
}

# 2. The entire managed composition must change while its Desktop is fully quit. Fixture homes under
#    this project's own test-work directory are never loaded by a running Desktop and are exempt.
$processName = if ($runtime.kind -eq 'official-desktop') { 'DeepSeek Harness' } else { 'DSH Desktop' }
$ltTestWork = [System.IO.Path]::GetFullPath((Join-Path $root 'test-work')).TrimEnd('\', '/') + '\'
$ltTargetHome = [System.IO.Path]::GetFullPath($DshHome).TrimEnd('\', '/') + '\'
$isTestFixtureHome = $ltTargetHome.StartsWith($ltTestWork, [System.StringComparison]::OrdinalIgnoreCase)
if ((-not $isTestFixtureHome) -and (Get-Process -Name $processName -ErrorAction SilentlyContinue)) {
    throw 'DeepSeek Harness Desktop is running: quit it completely (tray icon too) and retry'
}

# 3. Profile directory verification
$profileDir = Join-Path $DshHome "profiles\$Profile"
if (-not (Test-Path -LiteralPath $profileDir)) {
    throw "Profile directory not found: $profileDir (open DSH Desktop once, then quit it)"
}
$profilePkgFile = Join-Path $profileDir 'package.json'
if (Test-Path -LiteralPath $profilePkgFile -PathType Leaf) {
    try {
        $profilePkg = Get-Content -LiteralPath $profilePkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $installedBundles = @($profilePkg.dsh.profile.bundles)
        if ($installedBundles -contains 'dsh-leaderteam') {
            throw "Profile '$Profile' already has the standard 'dsh-leaderteam' bundle installed via 'dsh plugin'. Do not mix legacy cordis.patch.yml installation with dsh.bundle; manage upgrades via 'dsh plugin add' instead."
        }
    } catch {
        if ($_.Exception.Message -like "*already has the standard 'dsh-leaderteam' bundle*") { throw }
    }
}

$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$begin = '# >>> leaderteam (managed by scripts/install-desktop.ps1; do not edit inside)'
$end = '# <<< leaderteam'

$desktopBlock = (Get-Content -LiteralPath (Join-Path $root 'config\desktop.patch.yml') -Raw -Encoding UTF8).Replace('__LT_ROOT_URL__', $rootUrl).Replace('__LT_ROOT__', $fwdRoot).Replace('__LT_CONFIG__', "$fwdRoot/config/leaderteam.config.json").Trim()
$magpieBlock = (Get-Content -LiteralPath (Join-Path $root 'config\desktop-magpie.patch.yml') -Raw -Encoding UTF8).Replace('__MAGPIE_BASEURL__', $MagpieBaseUrl).Trim()

$current = ''
if (Test-Path -LiteralPath $patchFile) { $current = Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8 }
if ($null -eq $current) { $current = '' }
$managedBody = $null
$beginIdx = $current.IndexOf($begin, [System.StringComparison]::Ordinal)
$endIdx = if ($beginIdx -ge 0) { $current.IndexOf($end, $beginIdx + $begin.Length, [System.StringComparison]::Ordinal) } else { -1 }
if ($beginIdx -ge 0 -and $endIdx -lt 0) {
    throw "Corrupted LeaderTeam marker block in $patchFile (missing end marker). No files were changed."
}
if ($beginIdx -ge 0 -and $endIdx -gt $beginIdx) {
    $before = $current.Substring(0, $beginIdx).TrimEnd()
    $innerStart = $beginIdx + $begin.Length
    $managedBody = $current.Substring($innerStart, $endIdx - $innerStart).Trim()
    $after = $current.Substring($endIdx + $end.Length).TrimStart("`r", "`n").TrimEnd()
    $stripped = (@($before, $after) | Where-Object { $_ }) -join "`n"
} else {
    $stripped = $current.TrimEnd()
}

# 4. Safety check: ensure unmanaged content does not already define conflicting provider 'magpie'
if ($stripped -match '(?m)^\s*magpie\s*:') {
    throw "Provider 'magpie' is already defined in $patchFile outside the managed block. Refusing to overwrite silently."
}

# Cordis replaces config wholesale. Merge the original config locally before
# appending its final override, using the Desktop's existing YAML parser.
if (-not $desktopExe) { throw 'Desktop executable is required for local configuration merging.' }
$desktopExe = [System.IO.Path]::GetFullPath($desktopExe)
$resolvedModuleRoot = [System.IO.Path]::GetFullPath($moduleRoot)
$mergeScript = Join-Path $root 'scripts\dev\merge-desktop-provider.cjs'
$mergeStart = New-Object System.Diagnostics.ProcessStartInfo
$mergeStart.FileName = $desktopExe
$mergeStart.Arguments = '"' + $mergeScript + '" "' + $resolvedModuleRoot + '"'
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
    if (-not $mergeProcess.Start()) { throw 'Unable to start local configuration merger.' }
    $mergeInput = @{mode='install'; existing=$stripped; managed=$managedBody; template=$magpieBlock} | ConvertTo-Json -Compress -Depth 8
    $mergeProcess.StandardInput.Write($mergeInput)
    $mergeProcess.StandardInput.Close()
    $mergeOutput = $mergeProcess.StandardOutput.ReadToEnd()
    $mergeError = $mergeProcess.StandardError.ReadToEnd()
    $mergeProcess.WaitForExit()
    if ($mergeProcess.ExitCode -ne 0) {
        if ($mergeError.Trim() -eq 'MAGPIE_ALREADY_EXISTS') {
            throw "Provider 'magpie' is already defined outside the managed block."
        }
        throw 'Cannot merge the existing profile safely; invalid or unsupported YAML/configuration. No files were changed.'
    }
    try { $merged = $mergeOutput | ConvertFrom-Json } catch { throw 'Local configuration merger returned an invalid response.' }
} finally { $mergeProcess.Dispose() }
$stripped = $merged.prefix.TrimEnd()
$managedContent = "$begin`n$desktopBlock`n$($merged.block.Trim())`n$end"

$newText = ($(if ($stripped) { "$stripped`n`n" } else { '' })) + "$managedContent`n"

# Idempotence check: return early if configuration is already identical
$normCurrent = ($current -replace "\r\n", "`n").Trim()
$normNew = ($newText -replace "\r\n", "`n").Trim()
if ($normCurrent -and ($normCurrent -eq $normNew)) {
    Write-Host "LeaderTeam configuration is already up to date in $patchFile (idempotent; no changes made)."
    return
}

# 5. DryRun: display target and managed block without writing or echoing raw existing patch
if ($DryRun) {
    Write-Host "[DryRun] No files will be modified."
    Write-Host "Target patch file: $patchFile"
    Write-Host "Target profile: $Profile (under $DshHome)"
    Write-Host "Existing providers preserved: $($merged.originalProviderCount)"
    Write-Host 'LeaderTeam presets and the local Magpie provider will be installed. Existing configuration values are omitted.'
    return
}

# 6. Backup existing configuration
if (-not $BackupDir) {
    $baseName = "desktop-profile-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    $candidateDir = Join-Path $root ("backups\" + $baseName)
    $counter = 1
    while (Test-Path -LiteralPath $candidateDir) {
        $candidateDir = Join-Path $root ("backups\" + $baseName + "-$counter")
        $counter++
    }
    $BackupDir = $candidateDir
}
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$filesToBackup = @(
    @{ Source = $patchFile; DestName = 'cordis.patch.yml' },
    @{ Source = (Join-Path $DshHome 'settings.yaml'); DestName = 'settings.yaml' },
    @{ Source = (Join-Path $DshHome 'settings.yaml.imported'); DestName = 'settings.yaml.imported' }
)
foreach ($f in $filesToBackup) {
    if (Test-Path -LiteralPath $f.Source -PathType Leaf) {
        $destFile = Join-Path $BackupDir $f.DestName
        if (-not (Test-Path -LiteralPath $destFile)) {
            Copy-Item -LiteralPath $f.Source -Destination $destFile
        }
    }
}

# 7. Atomic UTF-8 without BOM write
$patchDir = Split-Path -Parent $patchFile
$tmpFile = Join-Path $patchDir (".tmp-patch-" + [System.Guid]::NewGuid().ToString('N'))
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tmpFile, $newText, $utf8NoBom)
if ([System.IO.File]::Exists($patchFile)) {
    [System.IO.File]::Replace($tmpFile, $patchFile, [NullString]::Value)
} else {
    [System.IO.File]::Move($tmpFile, $patchFile)
}

Write-Host "installed LeaderTeam rows and Magpie provider into $patchFile (backup: $BackupDir)"
$leaderHint = 'the configured roles.leader model'
try {
    $ltCfg = Get-Content -LiteralPath (Join-Path $root 'config\leaderteam.config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $ltLocalPath = Join-Path $root 'config\leaderteam.local.json'
    if (Test-Path -LiteralPath $ltLocalPath -PathType Leaf) {
        $ltLocal = Get-Content -LiteralPath $ltLocalPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($ltLocal.roles -and $ltLocal.roles.leader) { $ltCfg.roles.leader = $ltLocal.roles.leader }
    }
    $leaderRoute = [string]$ltCfg.roles.leader.route
    $leaderEffort = [string]$ltCfg.roles.leader.effort
    if ($leaderRoute) { $leaderHint = "Magpie $leaderRoute ($leaderEffort)" }
} catch {}
Write-Host "Next: start DeepSeek Harness Desktop, open a new session, choose the `"LeaderTeam`" preset and $leaderHint."
