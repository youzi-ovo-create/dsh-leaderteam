param(
    [Parameter()] [string] $CandidateApp,
    [Parameter()] [string] $Installer,
    [Parameter()] [string] $WorkDir,
    [Parameter()] [string] $SevenZip = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$QualificationRoot = Join-Path $Root 'scratch\update-qualification'
$script:StartedUtc = [DateTimeOffset]::UtcNow

function Write-TextUtf8 {
    param([string] $Path, [string] $Text)
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Append-Log {
    param([string] $Path, [string] $Text)
    [System.IO.File]::AppendAllText($Path, "[$([DateTimeOffset]::UtcNow.ToString('o'))] $Text`r`n", [System.Text.UTF8Encoding]::new($false))
}

function Test-UnsafeAttributes {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path -Force
    return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
        (($item.Attributes -band [IO.FileAttributes]::Encrypted) -ne 0)
}

function Assert-SafeInput {
    param([string] $Path, [string] $Label)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "$Label is required" }
    $full = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $Path))
    if (-not (Test-Path -LiteralPath $full)) { throw "$Label does not exist: $full" }
    Assert-SafeAncestors $full
    return $full
}

function Assert-SafeAncestors {
    param([string] $Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-UnsafeAttributes $current) { throw "Reparse/EFS ancestor is rejected: $current" }
        $parent = [IO.Path]::GetDirectoryName($current)
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
    }
}

function Assert-SafeTree {
    param([string] $Path)
    Assert-SafeAncestors $Path
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Path)
    while ($pending.Count -gt 0) {
        foreach ($item in @(Get-ChildItem -LiteralPath $pending.Pop() -Force)) {
            if (($item.Attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Encrypted)) -ne 0) { throw "Linked/EFS candidate entry rejected: $($item.FullName)" }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
}

function New-SafeWorkDirectory {
    if ([string]::IsNullOrWhiteSpace($WorkDir)) {
        $stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss-fffffff')
        $random = [Guid]::NewGuid().ToString('N').Substring(0, 8)
        $requested = Join-Path $QualificationRoot "run-$stamp-$random"
    } else {
        $requested = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $WorkDir))
    }
    $baseFull = [IO.Path]::GetFullPath($QualificationRoot)
    $prefix = $baseFull.TrimEnd('\') + '\'
    if (-not $requested.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "WorkDir must be a new directory under $baseFull; rejected: $requested"
    }
    if (Test-Path -LiteralPath $requested) { throw "WorkDir already exists: $requested" }
    Assert-SafeAncestors $requested
    $current = $Root
    foreach ($part in [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($requested)).Substring($Root.Length).TrimStart('\').Split('\')) {
        if ([string]::IsNullOrEmpty($part)) { continue }
        $current = Join-Path $current $part
        if (-not (Test-Path -LiteralPath $current)) { continue }
        if (Test-UnsafeAttributes $current) { throw "Reparse/EFS ancestor is not allowed: $current" }
        if (-not (Get-Item -LiteralPath $current -Force).PSIsContainer) { throw "WorkDir ancestor is not a directory: $current" }
    }
    New-Item -ItemType Directory -Path $requested -Force | Out-Null
    return $requested
}

function Get-FileSha256 {
    param([string] $Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()) }
        finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}

function Get-SignatureRecord {
    param([string] $Path, [string] $Role)
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    $subject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
    $timestamp = if ($null -ne $signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null }
    [ordered]@{
        role = $Role
        path = $Path
        status = [string] $signature.Status
        statusMessage = $signature.StatusMessage
        signerSubject = $subject
        signerThumbprint = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
        timestampSubject = $timestamp
        isDeepSeekSigned = ($signature.Status -eq 'Valid' -and $subject -like '*DeepSeek Artificial Intelligence*')
        sha256 = Get-FileSha256 $Path
    }
}

function Invoke-SevenZip {
    param([string[]] $Arguments, [string] $LogFile)
    $output = & $SevenZip @Arguments 2>&1
    $exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { -1 }
    $text = ($output | ForEach-Object { [string] $_ }) -join "`r`n"
    Append-Log $LogFile "7z exit=$exitCode args=$($Arguments -join ' ')`r`n$text"
    if ($exitCode -ne 0) { throw "7-Zip failed with exit code $exitCode; see $LogFile" }
    return $output
}

function Get-ArchivePaths {
    param([string[]] $Listing)
    $paths = @()
    foreach ($line in $Listing) {
        if ($line -match '^(Symbolic Link|Hard Link)\s*=\s*\S' -or $line -match '^Attributes\s*=.*\bl[rwx-]{9}') { throw 'Archive links are not permitted.' }
        if ($line -match '^Path\s*=\s*(.+)$') { $paths += $Matches[1].Trim() }
    }
    return $paths
}

function Assert-SafeArchivePaths {
    param([string[]] $Paths)
    foreach ($archivePath in $Paths) {
        if ([string]::IsNullOrWhiteSpace($archivePath)) { throw "7z archive contains an empty path" }
        if ($archivePath -match '^[\\/]' -or $archivePath.Contains(':') -or $archivePath -match '[\x00-\x1f]') {
            throw "7z archive contains a non-relative or alternate-data path: $archivePath"
        }
        $segments = $archivePath -split '[\\/]'
        if ($segments -contains '..') { throw "7z archive contains a parent traversal path: $archivePath" }
    }
}

function Write-FailureResult {
    param([string] $WorkDirectory, [string] $Stage, [string] $Message)
    if ([string]::IsNullOrWhiteSpace($WorkDirectory) -or -not (Test-Path -LiteralPath $WorkDirectory)) {
        Write-Error "[$Stage] $Message"
        return
    }
    $finished = [DateTimeOffset]::UtcNow
    $result = [ordered]@{
        schemaVersion = 1
        status = 'failed'
        automatedPassed = $false
        needsNativeQualification = $true
        stage = $Stage
        failures = @($Message)
        workDir = $WorkDirectory
        timing = @{
            startedAt = $script:StartedUtc.ToString('o')
            finishedAt = $finished.ToString('o')
            durationMs = [long] (($finished - $script:StartedUtc).TotalMilliseconds)
        }
    }
    Write-TextUtf8 (Join-Path $WorkDirectory 'result.json') ($result | ConvertTo-Json -Depth 8)
    Append-Log (Join-Path $WorkDirectory 'verification.log') "ERROR stage=$Stage message=$Message"
    Write-Error "[$Stage] $Message"
}

$createdWorkDir = $null
$candidateFullPath = $null
$installerFullPath = $null
$candidateSource = $null
try {
    if ([string]::IsNullOrWhiteSpace($CandidateApp) -eq [string]::IsNullOrWhiteSpace($Installer)) {
        throw 'Provide exactly one of -CandidateApp or -Installer.'
    }
    if (-not [string]::IsNullOrWhiteSpace($SevenZip)) {
        $SevenZip = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $SevenZip))
    } else {
        $cmd7z = (Get-Command 7z -ErrorAction SilentlyContinue)
        $candidates7z = @(
            $(if ($cmd7z) { $cmd7z.Source }),
            $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles '7-Zip\7z.exe' }),
            $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe' })
        ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
        if (-not $candidates7z -or $candidates7z.Count -eq 0) {
            throw '7z.exe not found; install 7-Zip or pass -SevenZip <path-to-7z.exe>.'
        }
        $SevenZip = $candidates7z[0]
    }
    if (-not (Test-Path -LiteralPath $SevenZip) -or (Get-Item -LiteralPath $SevenZip -Force).PSIsContainer) {
        throw "7-Zip executable not found: $SevenZip"
    }
    Assert-SafeAncestors $SevenZip

    $createdWorkDir = New-SafeWorkDirectory
    $logPath = Join-Path $createdWorkDir 'verification.log'
    Append-Log $logPath "PowerShell entry started root=$Root"
    $signatureRecords = @{}

    if (-not [string]::IsNullOrWhiteSpace($Installer)) {
        $installerFullPath = Assert-SafeInput $Installer 'Installer'
        if ((Get-Item -LiteralPath $installerFullPath -Force).PSIsContainer) { throw "Installer must be a file: $installerFullPath" }
        $installerSignature = Get-SignatureRecord $installerFullPath 'installer'
        $signatureRecords.installer = $installerSignature
        if (-not $installerSignature.isDeepSeekSigned) { throw "Installer signature is not a valid DeepSeek signature: $($installerSignature.status)" }
        $candidateSource = 'installer-extracted'
        $nsisDir = Join-Path $createdWorkDir 'downloaded-nsis'
        $extractionDir = Join-Path $createdWorkDir 'candidate-extracted'
        New-Item -ItemType Directory -Path $nsisDir -Force | Out-Null
        New-Item -ItemType Directory -Path $extractionDir -Force | Out-Null
        $outerListing = Invoke-SevenZip @('l', '-slt', '-ba', '--', $installerFullPath) $logPath
        $outerPaths = Get-ArchivePaths $outerListing
        Assert-SafeArchivePaths $outerPaths
        $appArchives = @($outerPaths | Where-Object { $_ -match '(?:^|[\\/])app-64\.7z$' })
        if ($appArchives.Count -ne 1) { throw "Expected exactly one NSIS app-64.7z entry, found $($appArchives.Count)" }
        Invoke-SevenZip @('x', '-y', "-o$nsisDir", '--', $installerFullPath, $appArchives[0]) $logPath | Out-Null
        Assert-SafeTree $nsisDir
        $nestedArchive = Get-ChildItem -LiteralPath $nsisDir -Recurse -Force -Filter 'app-64.7z' | Select-Object -First 1
        if ($null -eq $nestedArchive) { throw '7z did not produce the listed app-64.7z file' }
        $nestedListing = Invoke-SevenZip @('l', '-slt', '-ba', '--', $nestedArchive.FullName) $logPath
        $nestedPaths = Get-ArchivePaths $nestedListing
        Assert-SafeArchivePaths $nestedPaths
        Invoke-SevenZip @('x', '-y', "-o$extractionDir", '--', $nestedArchive.FullName) $logPath | Out-Null
        Assert-SafeTree $extractionDir
        $unsafeItems = @(Get-ChildItem -LiteralPath $extractionDir -Recurse -Force | Where-Object {
            (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
            (($_.Attributes -band [IO.FileAttributes]::Encrypted) -ne 0)
        })
        if ($unsafeItems.Count -gt 0) { throw "Extracted candidate contains reparse/EFS entries; first: $($unsafeItems[0].FullName)" }
        $executables = @(Get-ChildItem -LiteralPath $extractionDir -Recurse -Force -Filter 'DeepSeek Harness.exe' | Where-Object { -not $_.PSIsContainer })
        if ($executables.Count -ne 1) { throw "Expected exactly one DeepSeek Harness.exe after extraction, found $($executables.Count)" }
        $candidateFullPath = $executables[0].DirectoryName
        if (-not (Test-Path -LiteralPath (Join-Path $candidateFullPath 'resources\app.asar'))) {
            throw "Extracted executable does not have the official sibling resources layout: $candidateFullPath"
        }
        $exeSignature = Get-SignatureRecord $executables[0].FullName 'extracted-executable'
        $signatureRecords.exe = $exeSignature
        if (-not $exeSignature.isDeepSeekSigned) { throw "Extracted EXE signature is not a valid DeepSeek signature: $($exeSignature.status)" }
        $extractionReport = [ordered]@{
            installer = $installerFullPath
            installerSHA256 = $installerSignature.sha256
            outerAppArchive = $appArchives[0]
            extractedAppArchive = $nestedArchive.FullName
            candidateApp = $candidateFullPath
            executedInstaller = $false
        }
        Write-TextUtf8 (Join-Path $createdWorkDir 'extraction.json') ($extractionReport | ConvertTo-Json -Depth 5)
    } else {
        $candidateFullPath = Assert-SafeInput $CandidateApp 'CandidateApp'
        if (-not (Get-Item -LiteralPath $candidateFullPath -Force).PSIsContainer) { throw "CandidateApp must be a directory: $candidateFullPath" }
        Assert-SafeTree $candidateFullPath
        $exe = Join-Path $candidateFullPath 'DeepSeek Harness.exe'
        if (-not (Test-Path -LiteralPath $exe)) { throw "CandidateApp missing DeepSeek Harness.exe: $exe" }
        $exeSignature = Get-SignatureRecord $exe 'candidate-executable'
        $signatureRecords.exe = $exeSignature
        if (-not $exeSignature.isDeepSeekSigned) { throw "Candidate EXE signature is not a valid DeepSeek signature: $($exeSignature.status)" }
        $candidateSource = 'candidate-directory'
    }

    $signaturePath = Join-Path $createdWorkDir 'signature.json'
    Write-TextUtf8 $signaturePath ($signatureRecords | ConvertTo-Json -Depth 8)
    Append-Log $logPath "PowerShell preflight complete candidate=$candidateFullPath"

    $node = if ($null -ne $env:LT_NODE) { $env:LT_NODE } else { 'node' }
    $nodeArguments = @(
        (Join-Path $Root 'scripts\dev\verify-desktop-update.mjs'),
        '--candidate-app', $candidateFullPath,
        '--work-dir', $createdWorkDir,
        '--candidate-source', $candidateSource,
        '--signature', $signaturePath
    )
    if ($null -ne $installerFullPath) { $nodeArguments += @('--installer', $installerFullPath) }
    & $node @nodeArguments
    if ($LASTEXITCODE -ne 0) {
        Append-Log $logPath "Node verification failed with exit code $LASTEXITCODE; detailed result retained."
        exit 1
    }
    exit 0
} catch {
    Write-FailureResult $createdWorkDir 'powershell-entry' $_.Exception.Message
    exit 1
}
