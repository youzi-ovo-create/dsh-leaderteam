# Isolated native test suite for backup-desktop.ps1. All fixtures remain under project test-work.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$testWorkRoot = Join-Path $projectRoot 'test-work'
if (-not (Test-Path -LiteralPath $testWorkRoot)) {
    New-Item -ItemType Directory -Path $testWorkRoot | Out-Null
}

$fixtureName = 'desktop-backup-test-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 10)
$fixtureRoot = Join-Path $testWorkRoot $fixtureName
$programRoot = Join-Path $fixtureRoot 'program'
$dataRoot = Join-Path $fixtureRoot 'data'
$externalRoot = Join-Path $testWorkRoot ("$fixtureName-external")
$scriptPath = Join-Path $projectRoot 'scripts\deployment\backup-desktop.ps1'

$passedCount = 0
$failedCount = 0
function Assert-True {
    param([bool]$Condition, [string]$Message)
    if ($Condition) {
        $script:passedCount++
        Write-Host "  [PASS] $Message" -ForegroundColor Green
    }
    else {
        $script:failedCount++
        Write-Host "  [FAIL] $Message" -ForegroundColor Red
    }
}

function Invoke-ExpectFailure {
    param([scriptblock]$Operation)
    try {
        & $Operation 2> $null > $null
        return $false
    }
    catch {
        return $true
    }
}

New-Item -ItemType Directory -Path (Join-Path $programRoot 'app'), (Join-Path $programRoot 'empty-directory'), (Join-Path $programRoot 'link-parent'), (Join-Path $dataRoot 'profiles'), (Join-Path $dataRoot 'data-empty'), (Join-Path $dataRoot 'plugins') | Out-Null
New-Item -ItemType Directory -Path $externalRoot | Out-Null
Set-Content -LiteralPath (Join-Path $programRoot 'package.json') -Value '{"version":"9.9.9-test"}' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $programRoot 'app\current.txt') -Value 'program-original' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $dataRoot 'profiles\settings.txt') -Value 'data-original' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $externalRoot 'external.txt') -Value 'external-not-copied' -Encoding UTF8
$programLink = Join-Path $programRoot 'link-parent\program-link'
$dataLink = Join-Path $dataRoot 'plugins\data-link'
New-Item -ItemType Junction -Path $programLink -Target $externalRoot | Out-Null
New-Item -ItemType Junction -Path $dataLink -Target $externalRoot | Out-Null

Write-Host '=== Starting DSH Desktop Backup Test Suite ===' -ForegroundColor Cyan
Write-Host "Fixture: $fixtureName"

$previewDir = Join-Path $testWorkRoot ("$fixtureName-preview")
$previewOutput = & $scriptPath -BackupDir $previewDir -ProgramDir $programRoot -DataDir $dataRoot
$previewSucceeded = ($LASTEXITCODE -eq 0)
Assert-True $previewSucceeded 'default preview succeeds'
Assert-True (-not (Test-Path -LiteralPath $previewDir)) 'default preview performs zero writes'
Assert-True (($previewOutput -join ' ') -notmatch 'program-original|data-original|external-not-copied') 'preview does not print file content'

$invalidDataRoot = Join-Path $projectRoot 'outside-test-work-data'
$invalidCustomRejected = Invoke-ExpectFailure -Operation {
    & $scriptPath -BackupDir $previewDir -ProgramDir $programRoot -DataDir $invalidDataRoot
}
Assert-True $invalidCustomRejected 'one custom and one daily-like source path is rejected'

$nestedProgramRoot = Join-Path $fixtureRoot 'nested-program'
$nestedDataRoot = Join-Path $nestedProgramRoot 'nested-data'
New-Item -ItemType Directory -Path $nestedDataRoot | Out-Null
$nestedRejected = Invoke-ExpectFailure -Operation {
    & $scriptPath -BackupDir $previewDir -ProgramDir $nestedProgramRoot -DataDir $nestedDataRoot
}
Assert-True $nestedRejected 'nested source roots are rejected'

$reparseFixtureRoot = Join-Path $testWorkRoot ("$fixtureName-reparse-root")
$reparseTarget = Join-Path $testWorkRoot ("$fixtureName-reparse-target")
New-Item -ItemType Directory -Path $reparseTarget | Out-Null
New-Item -ItemType Junction -Path $reparseFixtureRoot -Target $reparseTarget | Out-Null
$reparseRootRejected = Invoke-ExpectFailure -Operation {
    & $scriptPath -BackupDir $previewDir -ProgramDir $reparseFixtureRoot -DataDir $dataRoot
}
Assert-True $reparseRootRejected 'reparse-point source root is rejected'

# Leaf directories are ordinary, but a junction ancestor escapes test-work.
# This is a preview: even a regression must never create an external backup.
$ancestorAlias = Join-Path $testWorkRoot ("$fixtureName-ancestor-alias")
New-Item -ItemType Junction -Path $ancestorAlias -Target $projectRoot | Out-Null
$unwrittenBackup = Join-Path ([System.IO.Path]::GetTempPath()) ("$fixtureName-never-created")
$ancestorEscapeRejected = Invoke-ExpectFailure -Operation {
    & $scriptPath -BackupDir $unwrittenBackup -ProgramDir (Join-Path $ancestorAlias 'config') -DataDir (Join-Path $ancestorAlias 'scripts')
}
Assert-True $ancestorEscapeRejected 'custom source paths cannot escape through a junction ancestor'
Assert-True (-not (Test-Path -LiteralPath $unwrittenBackup)) 'ancestor escape rejection creates no external backup'

$occupiedBackupRoot = Join-Path $testWorkRoot ("$fixtureName-occupied")
New-Item -ItemType Directory -Path $occupiedBackupRoot | Out-Null
Set-Content -LiteralPath (Join-Path $occupiedBackupRoot 'sentinel.txt') -Value 'occupied' -Encoding UTF8
$occupiedRejected = Invoke-ExpectFailure -Operation {
    & $scriptPath -BackupDir $occupiedBackupRoot -Execute -ProgramDir $programRoot -DataDir $dataRoot
}
Assert-True $occupiedRejected 'nonempty existing backup target is rejected'
Assert-True (Test-Path -LiteralPath (Join-Path $occupiedBackupRoot 'sentinel.txt')) 'occupied target remains untouched'

$fileOccupiedBackupRoot = Join-Path $testWorkRoot ("$fixtureName-file-occupied")
Set-Content -LiteralPath $fileOccupiedBackupRoot -Value 'file' -Encoding UTF8
$fileOccupiedRejected = Invoke-ExpectFailure -Operation {
    & $scriptPath -BackupDir $fileOccupiedBackupRoot -Execute -ProgramDir $programRoot -DataDir $dataRoot
}
Assert-True $fileOccupiedRejected 'file-occupied backup target is rejected'

$backupRoot = Join-Path $testWorkRoot ("$fixtureName-backup")
$backupOutput = & $scriptPath -BackupDir $backupRoot -Execute -ProgramDir $programRoot -DataDir $dataRoot
$backupSucceeded = ($LASTEXITCODE -eq 0)
Assert-True $backupSucceeded 'execute backup succeeds'
$manifest = Get-Content -LiteralPath (Join-Path $backupRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$status = Get-Content -LiteralPath (Join-Path $backupRoot 'status.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-True ($status.Status -eq 'Success') 'success status is written only after verification'
Assert-True ($manifest.Totals.FileCount -eq 3 -and $manifest.Totals.LinkCount -eq 2) 'manifest counts files and links without external targets'
Assert-True ($manifest.Roots[0].Files.Count -eq 2 -and $manifest.Roots[1].Files.Count -eq 1) 'each root has the expected file count'
Assert-True (@($manifest.Roots[0].EmptyDirectories + $manifest.Roots[1].EmptyDirectories).Count -eq 2) 'empty directories are recorded'
Assert-True ((Get-Item -LiteralPath (Join-Path $backupRoot 'program\link-parent\program-link') -Force).Attributes.ToString().Contains('ReparsePoint')) 'program junction is preserved as a link'
Assert-True ((Get-Item -LiteralPath (Join-Path $backupRoot 'data\plugins\data-link') -Force).Attributes.ToString().Contains('ReparsePoint')) 'data junction is preserved as a link'
Assert-True (-not (@($manifest.Roots | ForEach-Object { $_.Files } | Where-Object { $_.Path -like '*external.txt' }).Count -gt 0)) 'junction target content is not copied'
Assert-True (($backupOutput -join ' ') -notmatch 'program-original|data-original|external-not-copied') 'backup does not print file names or content'
Assert-True (Test-Path -LiteralPath (Join-Path $backupRoot 'logs\backup-program.log')) 'robocopy log is stored only in the backup directory'

Set-Content -LiteralPath (Join-Path $programRoot 'app\current.txt') -Value 'program-new' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $dataRoot 'profiles\settings.txt') -Value 'data-new' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $programRoot 'app\new-only.txt') -Value 'new-only' -Encoding UTF8

$restorePreviewOutput = & $scriptPath -BackupDir $backupRoot -Restore -ProgramDir $programRoot -DataDir $dataRoot
$restorePreviewSucceeded = ($LASTEXITCODE -eq 0)
Assert-True $restorePreviewSucceeded 'restore preview verifies backup without changes'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $backupRoot 'restore-status.json'))) 'restore preview writes no status'
Assert-True ((Get-Content -LiteralPath (Join-Path $programRoot 'app\current.txt') -Raw).TrimEnd() -eq 'program-new') 'restore preview leaves source modified'

$restoreOutput = & $scriptPath -BackupDir $backupRoot -Restore -Execute -ProgramDir $programRoot -DataDir $dataRoot
$restoreSucceeded = ($LASTEXITCODE -eq 0)
Assert-True $restoreSucceeded 'restore execute succeeds'
Assert-True ((Get-Content -LiteralPath (Join-Path $programRoot 'app\current.txt') -Raw).TrimEnd() -eq 'program-original') 'restore restores the old program file content'
Assert-True ((Get-Content -LiteralPath (Join-Path $dataRoot 'profiles\settings.txt') -Raw).TrimEnd() -eq 'data-original') 'restore restores the old data file content'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $programRoot 'app\new-only.txt'))) 'restore leaves no new-version-only file'
Assert-True (Test-Path -LiteralPath (Join-Path $programRoot 'empty-directory')) 'empty directories are restored'
Assert-True (@((Get-Item -LiteralPath $programLink -Force).Target)[0] -eq $externalRoot) 'restored junction still points to its original absolute target'
Assert-True (@((Get-Item -LiteralPath $dataLink -Force).Target)[0] -eq $externalRoot) 'second restored junction still points to its original absolute target'

$programFieldDirectories = @(Get-ChildItem -LiteralPath (Split-Path -Parent $programRoot) -Directory | Where-Object { $_.Name -like '*.pre-restore-*' -and $_.Name.StartsWith('program.pre-restore-') })
$dataFieldDirectories = @(Get-ChildItem -LiteralPath (Split-Path -Parent $dataRoot) -Directory | Where-Object { $_.Name -like '*.pre-restore-*' -and $_.Name.StartsWith('data.pre-restore-') })
Assert-True ($programFieldDirectories.Count -eq 1 -and $dataFieldDirectories.Count -eq 1) 'one field directory is retained for each source root'
Assert-True ((Get-Content -LiteralPath (Join-Path $programFieldDirectories[0].FullName 'app\current.txt') -Raw).TrimEnd() -eq 'program-new') 'program field directory preserves pre-restore content'
Assert-True (Test-Path -LiteralPath (Join-Path $programFieldDirectories[0].FullName 'app\new-only.txt')) 'program field directory preserves new-version-only file'
Assert-True ((Get-Content -LiteralPath (Join-Path $dataFieldDirectories[0].FullName 'profiles\settings.txt') -Raw).TrimEnd() -eq 'data-new') 'data field directory preserves pre-restore content'
Assert-True (Test-Path -LiteralPath (Join-Path $backupRoot 'restore-status.json')) 'successful restore status is stored in backup directory'
Assert-True (($restoreOutput -join ' ') -notmatch 'program-original|data-original|external-not-copied') 'restore does not print file names or content'
Assert-True ((Test-Path -LiteralPath (Join-Path $backupRoot 'logs\restore-program.log')) -or ((Get-ChildItem -LiteralPath (Join-Path $backupRoot 'logs') -Filter 'restore-*.log').Count -ge 2)) 'restore logs are stored in backup directory'

# Repeating a restore must retain every earlier field and update status safely.
& $scriptPath -BackupDir $backupRoot -Restore -Execute -ProgramDir $programRoot -DataDir $dataRoot
Assert-True ($LASTEXITCODE -eq 0) 'the same backup restores successfully a second time'
$allFields = @(Get-ChildItem -LiteralPath $fixtureRoot -Directory | Where-Object { $_.Name -like '*.pre-restore-*' })
Assert-True ($allFields.Count -eq 4) 'repeated restore retains both batches of field directories'

# A linked log directory must be rejected before either source tree is renamed.
$safeLogs = Join-Path $backupRoot 'logs-retained'
Move-Item -LiteralPath (Join-Path $backupRoot 'logs') -Destination $safeLogs
$controlTarget = Join-Path $testWorkRoot ("$fixtureName-control-target")
New-Item -ItemType Directory -Path $controlTarget | Out-Null
New-Item -ItemType Junction -Path (Join-Path $backupRoot 'logs') -Target $controlTarget | Out-Null
$linkedLogsRejected = Invoke-ExpectFailure -Operation {
    & $scriptPath -BackupDir $backupRoot -Restore -Execute -ProgramDir $programRoot -DataDir $dataRoot
}
Assert-True $linkedLogsRejected 'restore rejects a linked log directory'
Assert-True ((Get-ChildItem -LiteralPath $controlTarget -Force | Measure-Object).Count -eq 0) 'linked log target receives no files'
Assert-True ((Get-Content -LiteralPath (Join-Path $programRoot 'app\current.txt') -Raw).TrimEnd() -eq 'program-original') 'rejected restore preserves the original directory'
$fieldsAfterRejection = @(Get-ChildItem -LiteralPath $fixtureRoot -Directory | Where-Object { $_.Name -like '*.pre-restore-*' })
Assert-True ($fieldsAfterRejection.Count -eq 4) 'linked-control rejection happens before source renames'

$secondBackupRoot = Join-Path $testWorkRoot ("$fixtureName-second")
$wrongProgramRoot = Join-Path $fixtureRoot 'wrong-program'
New-Item -ItemType Directory -Path $wrongProgramRoot | Out-Null
$wrongTargetRejected = Invoke-ExpectFailure -Operation {
    & $scriptPath -BackupDir $secondBackupRoot -Restore -Execute -ProgramDir $wrongProgramRoot -DataDir $dataRoot
}
Assert-True $wrongTargetRejected 'restore rejects a manifest bound to different source paths'

Write-Host "`nPassed: $passedCount"
Write-Host "Failed: $failedCount"
if ($failedCount -gt 0) {
    exit 1
}
exit 0
