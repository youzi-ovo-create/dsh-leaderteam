# Test suite for install-desktop.ps1 and uninstall-desktop.ps1
# Runs natively in PowerShell without external dependencies (no Pester required).
# Strictly isolated to test-work fixture directory; never touches ~/.dsh or %APPDATA%\dsh-desktop.
$ErrorActionPreference = 'Stop'

$testRoot = Split-Path -Parent $PSScriptRoot
$testWorkDir = Join-Path $testRoot 'test-work'
if (-not (Test-Path -LiteralPath $testWorkDir)) {
    New-Item -ItemType Directory -Force -Path $testWorkDir | Out-Null
}

$fixtureDir = Join-Path $testWorkDir ("desktop-install-test-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $fixtureDir | Out-Null

$scriptsDir = Join-Path $testRoot 'scripts'
$installScript = Join-Path $scriptsDir 'install-desktop.ps1'
$uninstallScript = Join-Path $scriptsDir 'uninstall-desktop.ps1'
$resolvedRuntimeJson = & node (Join-Path $scriptsDir 'dsh-runtime.mjs') --json
if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve official DeepSeek Harness runtime for installer tests.' }
$realDshApp = [string]((($resolvedRuntimeJson -join "`n") | ConvertFrom-Json).app)

$passed = 0
$failed = 0

function Assert-True([bool]$condition, [string]$message) {
    if ($condition) {
        $global:passed++
        Write-Host "  [PASS] $message" -ForegroundColor Green
    } else {
        $global:failed++
        Write-Host "  [FAIL] $message" -ForegroundColor Red
    }
}

Write-Host "=== Starting DSH Desktop Installer Test Suite ===" -ForegroundColor Cyan
Write-Host "Fixture directory: $fixtureDir"
Write-Host "Valid DSH runtime: $realDshApp"

try {
    # Create mock invalid official app metadata (version 0.10.0)
    $mockApp010 = Join-Path $fixtureDir 'mock-app-0.10.0'
    New-Item -ItemType Directory -Force -Path (Join-Path $mockApp010 'resources\runtime\cli\bin'), (Join-Path $mockApp010 'resources\runtime\primary-runtime') | Out-Null
    Set-Content -LiteralPath (Join-Path $mockApp010 'DeepSeek Harness.exe') -Value '' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $mockApp010 'resources\app.asar') -Value '' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $mockApp010 'resources\runtime\cli\bin\dsh.cmd') -Value '' -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $mockApp010 'resources\runtime\primary-runtime\runtime.json') -Value '{"desktopVersion":"0.10.0"}' -Encoding UTF8

    # Setup isolated harness home
    $harnessHome = Join-Path $fixtureDir 'harness'
    $desktopProfile = Join-Path $harnessHome 'profiles\desktop'
    New-Item -ItemType Directory -Force -Path $desktopProfile | Out-Null

    $initialPatchContent = @"
# Existing cordis patch for user
- id: llm-pi-ai
  config:
    providers:
      deepseek:
        api: openai-completions
        baseURL: https://api.deepseek.com/v1
"@
    $patchFile = Join-Path $desktopProfile 'cordis.patch.yml'
    [System.IO.File]::WriteAllText($patchFile, $initialPatchContent, (New-Object System.Text.UTF8Encoding($false)))
    Set-Content -LiteralPath (Join-Path $harnessHome 'settings.yaml.imported') -Value 'imported: true' -Encoding UTF8

    # -------------------------------------------------------------
    # Test 1: Rejection on non-0.2.2-rc.1 version
    # -------------------------------------------------------------
    Write-Host "`nTest 1: Version verification rejects non-0.2.2-rc.1"
    $errThrown = $false
    try {
        & $installScript -DshHome $harnessHome -Profile 'desktop' -DshApp $mockApp010
    } catch {
        $errThrown = $true
        $errMessage = $_.Exception.Message
    }
    Assert-True $errThrown "Script threw error when pointing to 0.10.0"
    Assert-True ($errMessage -like "*0.2.2-rc.1*") "Error message states 0.2.2-rc.1 requirement"
    $contentAfterRejection = Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8
    Assert-True ($contentAfterRejection.Trim() -eq $initialPatchContent.Trim()) "Patch file remained untouched on version rejection"

    # -------------------------------------------------------------
    # Test 2: Rejection on missing profile directory
    # -------------------------------------------------------------
    Write-Host "`nTest 2: Rejection on missing profile directory"
    $missingHarnessHome = Join-Path $fixtureDir 'missing-harness'
    New-Item -ItemType Directory -Force -Path $missingHarnessHome | Out-Null
    $errThrown = $false
    try {
        & $installScript -DshHome $missingHarnessHome -Profile 'desktop' -DshApp $realDshApp
    } catch {
        $errThrown = $true
        $errMessage = $_.Exception.Message
    }
    Assert-True $errThrown "Script threw error when profile directory does not exist"
    Assert-True ($errMessage -like "*Profile directory not found*") "Error message mentions missing profile directory"

    # -------------------------------------------------------------
    # Test 3: Detection and rejection of existing unmanaged magpie provider
    # -------------------------------------------------------------
    Write-Host "`nTest 3: Detection of conflicting unmanaged magpie provider"
    $collisionHarnessHome = Join-Path $fixtureDir 'collision-harness'
    $collisionDesktopProfile = Join-Path $collisionHarnessHome 'profiles\desktop'
    New-Item -ItemType Directory -Force -Path $collisionDesktopProfile | Out-Null
    $collisionPatch = Join-Path $collisionDesktopProfile 'cordis.patch.yml'
    $collisionContent = @"
- id: llm-pi-ai
  config:
    providers:
      magpie:
        baseURL: http://custom-magpie:9999/v1
"@
    [System.IO.File]::WriteAllText($collisionPatch, $collisionContent, (New-Object System.Text.UTF8Encoding($false)))
    $errThrown = $false
    try {
        & $installScript -DshHome $collisionHarnessHome -Profile 'desktop' -DshApp $realDshApp
    } catch {
        $errThrown = $true
        $errMessage = $_.Exception.Message
    }
    Assert-True $errThrown "Script rejected existing unmanaged magpie provider"
    Assert-True ($errMessage -like "*Provider 'magpie' is already defined*") "Error message explains collision safety refusal"
    $collisionPatchAfter = Get-Content -LiteralPath $collisionPatch -Raw -Encoding UTF8
    Assert-True ($collisionPatchAfter.Trim() -eq $collisionContent.Trim()) "Collision fixture file was not overwritten"

    # -------------------------------------------------------------
    # Test 3b: Validation of -Profile parameter (prevent path traversal)
    # -------------------------------------------------------------
    Write-Host "`nTest 3b: Profile name validation rejects path traversal"
    $invalidProfiles = @('../desktop', 'desktop/sub', 'evil\profile', 'foo..bar')
    foreach ($badProf in $invalidProfiles) {
        $profErrThrown = $false
        try {
            & $installScript -DshHome $harnessHome -Profile $badProf -DshApp $realDshApp
        } catch {
            $profErrThrown = $true
            $profErrMsg = $_.Exception.Message
        }
        Assert-True $profErrThrown "Rejected invalid profile '$badProf'"
        Assert-True ($profErrMsg -like "*Invalid profile name*") "Error mentions invalid profile name"
    }

    # -------------------------------------------------------------
    # Test 3c: Validation of -MagpieBaseUrl parameter
    # -------------------------------------------------------------
    Write-Host "`nTest 3c: MagpieBaseUrl validation rejects unsafe or non-loopback URIs"
    # Non-http scheme
    $urlErrThrown = $false
    try {
        & $installScript -DshHome $harnessHome -Profile 'desktop' -DshApp $realDshApp -MagpieBaseUrl 'ftp://127.0.0.1:3425/v1'
    } catch {
        $urlErrThrown = $true
        $urlErrMsg = $_.Exception.Message
    }
    Assert-True $urlErrThrown "Rejected ftp scheme in MagpieBaseUrl"
    Assert-True ($urlErrMsg -like "*scheme must be http or https*") "Error message states scheme requirement"

    # Non-loopback address
    $urlErrThrown = $false
    try {
        & $installScript -DshHome $harnessHome -Profile 'desktop' -DshApp $realDshApp -MagpieBaseUrl 'http://192.168.1.100:3425/v1'
    } catch {
        $urlErrThrown = $true
        $urlErrMsg = $_.Exception.Message
    }
    Assert-True $urlErrThrown "Rejected non-loopback IP address"
    Assert-True ($urlErrMsg -like "*must be a loopback address*") "Error message states loopback requirement"

    # Embedded credentials
    $urlErrThrown = $false
    try {
        & $installScript -DshHome $harnessHome -Profile 'desktop' -DshApp $realDshApp -MagpieBaseUrl 'http://user:secret@127.0.0.1:3425/v1'
    } catch {
        $urlErrThrown = $true
        $urlErrMsg = $_.Exception.Message
    }
    Assert-True $urlErrThrown "Rejected embedded credentials in MagpieBaseUrl"
    Assert-True ($urlErrMsg -like "*embedded credentials*") "Error message states credentials rejection"
    Assert-True ($urlErrMsg -notlike '*user:secret*') "Credential URL is not echoed in the error"

    $urlErrThrown = $false
    try {
        $injectedUrl = 'http://127.0.0.1:3425/v1' + [Environment]::NewLine + '# YAML_INJECTION_PROOF'
        & $installScript -DryRun -DshHome $harnessHome -Profile 'desktop' -DshApp $realDshApp -MagpieBaseUrl $injectedUrl
    } catch {
        $urlErrThrown = $true
        $urlErrMsg = $_.Exception.Message
    }
    Assert-True $urlErrThrown "Rejected newline injection into the YAML provider template"
    Assert-True ((Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8).Trim() -eq $initialPatchContent.Trim()) "Rejected URL injection made zero patch changes"

    # -------------------------------------------------------------
    # Test 4: DryRun does not write files or backup
    # -------------------------------------------------------------
    Write-Host "`nTest 4: DryRun mode does zero writes"
    $fixtureBackupsDir = Join-Path $fixtureDir 'backups'
    $dryRunOutput = (& $installScript -DryRun -DshHome $harnessHome -DshApp $realDshApp -BackupDir $fixtureBackupsDir *>&1) | Out-String
    $patchAfterDryRun = Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8
    Assert-True ($patchAfterDryRun.Trim() -eq $initialPatchContent.Trim()) "DryRun did not modify patch file"
    Assert-True (-not (Test-Path -LiteralPath $fixtureBackupsDir)) "DryRun did not create any backup directory"
    Assert-True ($dryRunOutput -like "*[DryRun]*") "DryRun indicated dry-run execution"
    Assert-True ($dryRunOutput -notlike "*deepseek.com*") "DryRun did not print pre-existing raw patch secrets/content"

    # -------------------------------------------------------------
    # Test 5: First installation on desktop profile
    # -------------------------------------------------------------
    Write-Host "`nTest 5: First install onto desktop profile"
    & $installScript -DshHome $harnessHome -DshApp $realDshApp -BackupDir $fixtureBackupsDir
    $installedContent = Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8
    Assert-True (Test-Path -LiteralPath (Join-Path $fixtureBackupsDir 'cordis.patch.yml')) "Backup created in specified BackupDir"
    Assert-True (Test-Path -LiteralPath (Join-Path $fixtureBackupsDir 'settings.yaml.imported')) "Settings backup created in specified BackupDir"
    
    Assert-True ($installedContent -like "*# Existing cordis patch for user*") "Preserved original patch comments"
    Assert-True ($installedContent -like "*deepseek.com*") "Preserved original provider configuration"
    Assert-True ($installedContent -notmatch '(?m)^\s*(- id:\s*)?agent-default-model\s*:') "Did not inject or alter agent-default-model configuration"
    Assert-True ($installedContent -like "*# >>> leaderteam*") "Contains begin marker"
    Assert-True ($installedContent -like "*# <<< leaderteam*") "Contains end marker"
    Assert-True ($installedContent -like "*id: preset-leaderteam*") "Contains preset-leaderteam"
    Assert-True ($installedContent -like '*file:///*/leaderteam/entry-lead.mjs*') "Preset plugin uses a file URL supported by the Windows ESM loader"
    Assert-True ($installedContent -like "*id: preset-lt-member-readonly*") "Contains preset-lt-member-readonly"
    Assert-True ($installedContent -like "*id: preset-lt-member-code*") "Contains preset-lt-member-code"
    Assert-True ($installedContent -like "*id: preset-lt-member-shell*") "Contains preset-lt-member-shell"
    Assert-True ($installedContent -like "*magpie:*") "Contains magpie provider"
    Assert-True ($installedContent -like "*apiKeyEnv: LEADERTEAM_MAGPIE_KEY*") "Uses the official API-key environment reference"
    Assert-True ($installedContent -like "*baseURL: http://127.0.0.1:3425/v1*") "Contains baseURL: http://127.0.0.1:3425/v1"
    $cfgModels = @(((Get-Content -LiteralPath (Join-Path $testRoot 'config\leaderteam.config.json') -Raw -Encoding UTF8 | ConvertFrom-Json).models.PSObject.Properties).Name)
    $firstConfiguredModel = $cfgModels[0]
    $lastConfiguredModel = $cfgModels[$cfgModels.Count - 1]
    Assert-True ($installedContent -like "*$firstConfiguredModel*") "Contains first configured model $firstConfiguredModel"
    Assert-True ($installedContent -like "*$lastConfiguredModel*") "Contains last configured model $lastConfiguredModel"
    
    # Check single occurrence of markers
    $beginCount = ([regex]::Matches($installedContent, '# >>> leaderteam')).Count
    $endCount = ([regex]::Matches($installedContent, '# <<< leaderteam')).Count
    Assert-True ($beginCount -eq 1 -and $endCount -eq 1) "Managed markers appear exactly once"

    # Check UTF-8 without BOM
    $bytes = [System.IO.File]::ReadAllBytes($patchFile)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    Assert-True (-not $hasBom) "File is UTF-8 without BOM"

    # -------------------------------------------------------------
    # Test 6: Second installation (Idempotence)
    # -------------------------------------------------------------
    Write-Host "`nTest 6: Second install is idempotent"
    $backupPatchContentBefore = Get-Content -LiteralPath (Join-Path $fixtureBackupsDir 'cordis.patch.yml') -Raw -Encoding UTF8
    $secondInstallOutput = (& $installScript -DshHome $harnessHome -DshApp $realDshApp -BackupDir $fixtureBackupsDir *>&1) | Out-String
    $secondInstalledContent = Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8
    Assert-True ($secondInstalledContent -eq $installedContent) "Second install produces byte-identical content"
    Assert-True ($secondInstallOutput -like "*idempotent; no changes made*") "Second install reported idempotent early return"
    $backupPatchContentAfter = Get-Content -LiteralPath (Join-Path $fixtureBackupsDir 'cordis.patch.yml') -Raw -Encoding UTF8
    Assert-True ($backupPatchContentAfter -eq $backupPatchContentBefore) "Repeated install did not overwrite initial backup"
    $beginCount2 = ([regex]::Matches($secondInstalledContent, '# >>> leaderteam')).Count
    Assert-True ($beginCount2 -eq 1) "Managed block is not duplicated"

    # -------------------------------------------------------------
    # Test 7: Uninstall removes managed block and preserves original
    # -------------------------------------------------------------
    Write-Host "`nTest 7: Uninstall cleans managed block"
    & $uninstallScript -DshHome $harnessHome
    $uninstalledContent = Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8
    Assert-True ($uninstalledContent -notlike "*# >>> leaderteam*") "Begin marker removed"
    Assert-True ($uninstalledContent -notlike "*# <<< leaderteam*") "End marker removed"
    Assert-True ($uninstalledContent -notlike "*id: preset-leaderteam*") "Preset-leaderteam removed"
    Assert-True ($uninstalledContent -notlike "*magpie:*") "Magpie provider removed"
    Assert-True ($uninstalledContent -like "*# Existing cordis patch for user*") "Original comments intact"
    Assert-True ($uninstalledContent -like "*deepseek.com*") "Original provider intact"
    Assert-True ($uninstalledContent.Trim() -eq $initialPatchContent.Trim()) "File content returned to initial state"

    $bytesAfterUninstall = [System.IO.File]::ReadAllBytes($patchFile)
    $hasBomAfterUninstall = ($bytesAfterUninstall.Length -ge 3 -and $bytesAfterUninstall[0] -eq 0xEF -and $bytesAfterUninstall[1] -eq 0xBB -and $bytesAfterUninstall[2] -eq 0xBF)
    Assert-True (-not $hasBomAfterUninstall) "Uninstalled file is UTF-8 without BOM"

    # -------------------------------------------------------------
    # Test 8: Repeat uninstall is safe and idempotent
    # -------------------------------------------------------------
    Write-Host "`nTest 8: Repeat uninstall is safe and idempotent"
    $uninstallOutput = (& $uninstallScript -DshHome $harnessHome *>&1) | Out-String
    Assert-True ($uninstallOutput -like "*nothing to remove*") "Reported nothing to remove on second uninstall"
    $contentAfterSecondUninstall = Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8
    Assert-True ($contentAfterSecondUninstall.Trim() -eq $initialPatchContent.Trim()) "File content remained intact after repeated uninstall"

    # -------------------------------------------------------------
    # Test 9: Uninstall profile validation
    # -------------------------------------------------------------
    Write-Host "`nTest 9: Uninstall validates profile name"
    $uninstallProfErrThrown = $false
    try {
        & $uninstallScript -DshHome $harnessHome -Profile '../evil'
    } catch {
        $uninstallProfErrThrown = $true
        $uninstallProfErrMsg = $_.Exception.Message
    }
    Assert-True $uninstallProfErrThrown "Uninstall rejected profile with path traversal"
    Assert-True ($uninstallProfErrMsg -like "*Invalid profile name*") "Uninstall error mentions invalid profile name"

} finally {
    # Retain every fixture and backup as reviewable evidence.
}

Write-Host "`n=== Test Summary ===" -ForegroundColor Cyan
Write-Host "Total Passed: $passed" -ForegroundColor Green
Write-Host "Total Failed: $failed" -ForegroundColor $(if ($failed -gt 0) { 'Red' } else { 'Green' })

if ($failed -gt 0) {
    exit 1
} else {
    exit 0
}
