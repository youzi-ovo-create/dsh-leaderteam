# Creates or restores a reparse-point-safe local backup of DSH Desktop.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\deployment\backup-desktop.ps1 -BackupDir <new-dir> [-Execute]
# Restore: powershell -ExecutionPolicy Bypass -File scripts\deployment\backup-desktop.ps1 -BackupDir <existing-dir> -Restore [-Execute]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupDir,
    [switch]$Restore,
    [switch]$Execute,
    [string]$ProgramDir,
    [string]$DataDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:ScriptVersion = '1.0'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not ('BackupDesktopNativeMethods' -as [type])) {
    Add-Type -Namespace BackupDesktop -Name BackupDesktopNativeMethods -MemberDefinition @"
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(
    string lpFileName,
    uint dwDesiredAccess,
    uint dwShareMode,
    System.IntPtr lpSecurityAttributes,
    uint dwCreationDisposition,
    uint dwFlagsAndAttributes,
    System.IntPtr hTemplateFile);

[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern uint GetFinalPathNameByHandle(
    Microsoft.Win32.SafeHandles.SafeFileHandle hFile,
    System.Text.StringBuilder lpFilePath,
    uint lpFilePathSize,
    uint dwFlags);

[DllImport("kernel32.dll", SetLastError = true)]
private static extern bool SetFileTime(
    Microsoft.Win32.SafeHandles.SafeFileHandle hFile,
    ref long lpCreationTime,
    System.IntPtr lpLastAccessTime,
    ref long lpLastWriteTime);

public static bool SetFileTimes(
    Microsoft.Win32.SafeHandles.SafeFileHandle hFile,
    long creationFileTime,
    long lastWriteFileTime)
{
    return SetFileTime(hFile, ref creationFileTime, System.IntPtr.Zero, ref lastWriteFileTime);
}
"@
}

function Get-NormalizedFullPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'A required path is empty.'
    }
    if ($Path.IndexOf([char]0) -ge 0) {
        throw 'A path contains a control character.'
    }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath.Length -gt 3) {
        $fullPath = $fullPath.TrimEnd('\', '/')
    }
    return $fullPath
}

function Get-FinalPath {
    param([string]$Path)
    $handle = [BackupDesktop.BackupDesktopNativeMethods]::CreateFile(
        $Path,
        [uint32]0,
        [uint32]7,
        [System.IntPtr]::Zero,
        [uint32]3,
        [uint32]0x02000000,
        [System.IntPtr]::Zero)
    if ($null -eq $handle -or $handle.IsInvalid) {
        $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "Unable to resolve a path (Win32 error $errorCode)."
    }
    try {
        $capacity = [uint32]4096
        $buffer = New-Object System.Text.StringBuilder([int]$capacity)
        $result = [BackupDesktop.BackupDesktopNativeMethods]::GetFinalPathNameByHandle(
            $handle,
            $buffer,
            $capacity,
            [uint32]0)
        if ($result -eq 0) {
            $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "Unable to resolve a path (Win32 error $errorCode)."
        }
        if ($result -ge $capacity) {
            $capacity = [uint32]$result
            $buffer = New-Object System.Text.StringBuilder([int]$capacity)
            $result = [BackupDesktop.BackupDesktopNativeMethods]::GetFinalPathNameByHandle(
                $handle,
                $buffer,
                $capacity,
                [uint32]0)
            if ($result -eq 0 -or $result -ge $capacity) {
                throw 'Unable to resolve a path because its final path is too long.'
            }
        }
        $finalPath = $buffer.ToString()
        if ($finalPath.StartsWith('\\?\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) {
            $finalPath = '\\' + $finalPath.Substring(8)
        } elseif ($finalPath.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase)) {
            $finalPath = $finalPath.Substring(4)
        }
        if ($finalPath.Length -gt 3) {
            $finalPath = $finalPath.TrimEnd('\', '/')
        }
        return $finalPath
    }
    finally {
        $handle.Dispose()
    }
}

function Get-ExpectedFinalPath {
    param([string]$Path)
    $fullPath = Get-NormalizedFullPath -Path $Path
    if (Test-Path -LiteralPath $fullPath -PathType Any) {
        return Get-FinalPath -Path $fullPath
    }

    $nearestExisting = $fullPath
    $tail = [string]::Empty
    while (-not (Test-Path -LiteralPath $nearestExisting -PathType Any)) {
        $parent = [System.IO.Path]::GetDirectoryName($nearestExisting)
        if ([string]::IsNullOrEmpty($parent)) {
            throw 'A path has no existing ancestor.'
        }
        $tail = $nearestExisting.Substring($parent.Length) + $tail
        $nearestExisting = $parent
    }
    if (Test-Path -LiteralPath $nearestExisting -PathType Leaf) {
        throw 'A required parent path is occupied by a file.'
    }
    $finalBase = (Get-FinalPath -Path $nearestExisting)
    if ($finalBase.Length -gt 3) {
        $finalBase = $finalBase.TrimEnd('\', '/')
    }
    return $finalBase + $tail
}

function Test-SamePath {
    param([string]$LeftPath, [string]$RightPath)
    return [string]::Equals($LeftPath, $RightPath, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-PathInside {
    param([string]$ChildPath, [string]$ParentPath)
    if (Test-SamePath -LeftPath $ChildPath -RightPath $ParentPath) {
        return $true
    }
    return $ChildPath.StartsWith($ParentPath.TrimEnd('\', '/') + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-ItemMetadata {
    param($Item)
    return [pscustomobject]@{
        Attributes = $Item.Attributes.ToString()
        CreationTimeUtc = $Item.CreationTimeUtc.ToString('o')
        LastWriteTimeUtc = $Item.LastWriteTimeUtc.ToString('o')
    }
}

function Get-RelativeEntryPath {
    param([string]$RootPath, [string]$FullPath)
    $relativePath = $FullPath.Substring($RootPath.Length).TrimStart('\', '/')
    if ([string]::IsNullOrEmpty($relativePath)) {
        throw 'A source root was unexpectedly inventoried as one of its children.'
    }
    return $relativePath
}

function Get-FileSha256 {
    param([string]$Path)
    $stream = $null
    $hashAlgorithm = $null
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        $hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
        $hash = $hashAlgorithm.ComputeHash($stream)
        return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        if ($null -ne $hashAlgorithm) { $hashAlgorithm.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Get-StringSha256 {
    param([string]$Value)
    $hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
        $hash = $hashAlgorithm.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $hashAlgorithm.Dispose()
    }
}

function Get-TreeInventory {
    param(
        [string]$RootPath,
        [bool]$CalculateHashes
    )

    $rootItem = Get-Item -LiteralPath $RootPath -Force
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'A source root is a reparse point.'
    }

    $directories = New-Object 'System.Collections.Generic.List[object]'
    $files = New-Object 'System.Collections.Generic.List[object]'
    $links = New-Object 'System.Collections.Generic.List[object]'
    $pendingDirectories = New-Object 'System.Collections.Generic.Queue[string]'
    $pendingDirectories.Enqueue($RootPath)
    $directoriesWithChildren = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

    while ($pendingDirectories.Count -gt 0) {
        $currentDirectory = $pendingDirectories.Dequeue()
        $entryCount = 0
        $entries = $null
        try {
            $entries = [System.IO.Directory]::EnumerateFileSystemEntries($currentDirectory)
        }
        catch {
            throw 'Unable to enumerate one of the selected roots.'
        }

        foreach ($entry in $entries) {
            $entryCount++
            $item = Get-Item -LiteralPath $entry -Force
            $relativePath = Get-RelativeEntryPath -RootPath $RootPath -FullPath $entry
            if (-not [string]::Equals($currentDirectory, $RootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
                $currentRelativePath = Get-RelativeEntryPath -RootPath $RootPath -FullPath $currentDirectory
                [void]$directoriesWithChildren.Add($currentRelativePath)
            }
            $isReparsePoint = (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)

            if ($isReparsePoint) {
                if ($item.LinkType -notin @('Junction', 'SymbolicLink')) {
                    throw 'An unsupported reparse point exists under a selected root.'
                }
                $targetValue = $item.Target
                $target = $null
                if ($targetValue -is [array]) {
                    if ($targetValue.Count -eq 1 -and $targetValue[0] -is [string]) {
                        $target = $targetValue[0]
                    }
                }
                elseif ($targetValue -is [string]) {
                    $target = $targetValue
                }
                if ([string]::IsNullOrEmpty($target)) {
                    throw 'Unable to read the original target of a junction or symbolic link.'
                }
                $links.Add([pscustomobject]@{
                    Path = $relativePath
                    Type = $item.LinkType.ToLowerInvariant()
                    Target = $target
                    Attributes = $item.Attributes.ToString()
                    CreationTimeUtc = $item.CreationTimeUtc.ToString('o')
                    LastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('o')
                })
                continue
            }

            if ($item.PSIsContainer) {
                $pendingDirectories.Enqueue($entry)
                $metadata = Get-ItemMetadata -Item $item
                $directories.Add([pscustomobject]@{
                    Path = $relativePath
                    Attributes = $metadata.Attributes
                    CreationTimeUtc = $metadata.CreationTimeUtc
                    LastWriteTimeUtc = $metadata.LastWriteTimeUtc
                })
                continue
            }

            if (-not ($item -is [System.IO.FileInfo])) {
                throw 'An unsupported file-system entry exists under a selected root.'
            }
            $hash = $null
            if ($CalculateHashes) {
                try {
                    $hash = Get-FileSha256 -Path $entry
                }
                catch {
                    throw 'Unable to hash one of the selected roots.'
                }
            }
            $metadata = Get-ItemMetadata -Item $item
            $files.Add([pscustomobject]@{
                Path = $relativePath
                Length = [int64]$item.Length
                SHA256 = $hash
                Attributes = $metadata.Attributes
                CreationTimeUtc = $metadata.CreationTimeUtc
                LastWriteTimeUtc = $metadata.LastWriteTimeUtc
            })
        }

    }

    $emptyDirectorySet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($directory in $directories) {
        if (-not $directoriesWithChildren.Contains($directory.Path)) {
            [void]$emptyDirectorySet.Add($directory.Path)
        }
    }

    $sortedFiles = @($files | Sort-Object -Property Path)
    $sortedLinks = @($links | Sort-Object -Property Path)
    $sortedDirectories = @($directories | Sort-Object -Property Path)
    $sortedEmptyDirectories = @($emptyDirectorySet | Sort-Object)
    $totalBytes = [int64]0
    foreach ($file in $sortedFiles) {
        $totalBytes += $file.Length
    }

    $rootMetadata = Get-ItemMetadata -Item $rootItem
    return [pscustomobject]@{
        RootPath = $RootPath
        RootAttributes = $rootMetadata.Attributes
        RootCreationTimeUtc = $rootMetadata.CreationTimeUtc
        RootLastWriteTimeUtc = $rootMetadata.LastWriteTimeUtc
        Files = $sortedFiles
        Links = $sortedLinks
        Directories = $sortedDirectories
        EmptyDirectories = $sortedEmptyDirectories
        FileCount = $sortedFiles.Count
        LinkCount = $sortedLinks.Count
        DirectoryCount = $sortedDirectories.Count
        EmptyDirectoryCount = $sortedEmptyDirectories.Count
        TotalBytes = $totalBytes
    }
}

function Assert-RelativeEntryPath {
    param([string]$Path)
    if ([string]::IsNullOrEmpty($Path) -or
        $Path.StartsWith('\', [System.StringComparison]::Ordinal) -or
        $Path.StartsWith('/', [System.StringComparison]::Ordinal) -or
        $Path.Contains(':')) {
        throw 'Manifest contains an invalid relative path.'
    }
    $segments = $Path.Split([char[]]@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)
    foreach ($segment in $segments) {
        if ([string]::IsNullOrEmpty($segment) -or $segment -eq '.' -or $segment -eq '..') {
            throw 'Manifest contains an invalid relative path.'
        }
    }
}

function Assert-InventoryArrays {
    param($Root)
    $files = @($Root.Files)
    $links = @($Root.Links)
    $directories = @($Root.Directories)
    $emptyDirectories = @($Root.EmptyDirectories)
    $filePaths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    $linkPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    $directoryPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

    foreach ($file in $files) {
        if ($null -eq $file.Path -or $null -eq $file.Length -or $null -eq $file.SHA256 -or
            $file.Length -lt 0 -or $file.SHA256 -notmatch '^[0-9a-f]{64}$' -or
            [string]::IsNullOrEmpty($file.Attributes) -or
            [string]::IsNullOrEmpty($file.CreationTimeUtc) -or
            [string]::IsNullOrEmpty($file.LastWriteTimeUtc) -or
            [string]::IsNullOrEmpty($file.LastWriteTimeUtc)) {
            throw 'Manifest contains an invalid file record.'
        }
        Assert-RelativeEntryPath -Path $file.Path
        if (-not $filePaths.Add($file.Path)) {
            throw 'Manifest contains a duplicate file path.'
        }
    }
    foreach ($link in $links) {
        if ($null -eq $link.Path -or $null -eq $link.Type -or $null -eq $link.Target -or
            $link.Type -notin @('junction', 'symboliclink') -or [string]::IsNullOrEmpty($link.Target)) {
            throw 'Manifest contains an invalid link record.'
        }
        Assert-RelativeEntryPath -Path $link.Path
        if (-not $linkPaths.Add($link.Path)) {
            throw 'Manifest contains a duplicate link path.'
        }
    }
    foreach ($directory in $directories) {
        if ($null -eq $directory.Path -or [string]::IsNullOrEmpty($directory.Attributes) -or
            [string]::IsNullOrEmpty($directory.CreationTimeUtc) -or
            [string]::IsNullOrEmpty($directory.LastWriteTimeUtc) -or
            [string]::IsNullOrEmpty($directory.LastWriteTimeUtc)) {
            throw 'Manifest contains an invalid directory record.'
        }
        Assert-RelativeEntryPath -Path $directory.Path
        if (-not $directoryPaths.Add($directory.Path)) {
            throw 'Manifest contains a duplicate directory path.'
        }
    }
    foreach ($emptyDirectoryPath in $emptyDirectories) {
        Assert-RelativeEntryPath -Path $emptyDirectoryPath
        if (-not $directoryPaths.Contains($emptyDirectoryPath)) {
            throw 'Manifest contains an empty-directory path that is not a directory.'
        }
    }
    if ($files.Count -ne [int]$Root.FileCount -or $links.Count -ne [int]$Root.LinkCount -or
        $directories.Count -ne [int]$Root.DirectoryCount -or
        $emptyDirectories.Count -ne [int]$Root.EmptyDirectoryCount) {
        throw 'Manifest contains inconsistent counts.'
    }
    return [pscustomobject]@{
        Files = $files
        Links = $links
        Directories = $directories
        EmptyDirectories = $emptyDirectories
    }
}

function Assert-Manifest {
    param($Manifest)
    if ($null -eq $Manifest -or $Manifest.ManifestVersion -ne 1 -or
        [string]::IsNullOrEmpty($Manifest.CreatedAtUtc) -or
        [string]::IsNullOrEmpty($Manifest.ScriptVersion)) {
        throw 'Invalid backup manifest header.'
    }
    $roots = @($Manifest.Roots)
    if ($roots.Count -ne 2 -or
        $roots[0].Name -ne 'program' -or $roots[1].Name -ne 'data' -or
        [string]::IsNullOrEmpty($roots[0].OriginalPath) -or
        [string]::IsNullOrEmpty($roots[0].ResolvedPath) -or
        [string]::IsNullOrEmpty($roots[1].OriginalPath) -or
        [string]::IsNullOrEmpty($roots[1].ResolvedPath) -or
        [string]::IsNullOrEmpty($roots[0].RootAttributes) -or
        [string]::IsNullOrEmpty($roots[1].RootAttributes)) {
        throw 'Invalid backup manifest roots.'
    }
    foreach ($root in $roots) {
        [void](Assert-InventoryArrays -Root $root)
    }
    $totals = $Manifest.Totals
    $fileCount = $roots[0].FileCount + $roots[1].FileCount
    $linkCount = $roots[0].LinkCount + $roots[1].LinkCount
    $directoryCount = $roots[0].DirectoryCount + $roots[1].DirectoryCount
    $totalBytes = [int64]$roots[0].TotalBytes + [int64]$roots[1].TotalBytes
    if ($totals.FileCount -ne $fileCount -or $totals.LinkCount -ne $linkCount -or
        $totals.DirectoryCount -ne $directoryCount -or [int64]$totals.TotalBytes -ne $totalBytes) {
        throw 'Manifest totals are inconsistent.'
    }
}

function Compare-EntryList {
    param(
        [object[]]$Expected,
        [object[]]$Actual,
        [string[]]$Properties,
        [string]$EntryKind
    )
    if ($Expected.Count -ne $Actual.Count) {
        throw "Verification failed: $EntryKind count differs."
    }
    $actualByPath = @{}
    foreach ($actualEntry in $Actual) {
        if (-not $actualByPath.ContainsKey($actualEntry.Path)) {
            $actualByPath.Add($actualEntry.Path, $actualEntry)
        }
    }
    foreach ($expectedEntry in $Expected) {
        if (-not $actualByPath.ContainsKey($expectedEntry.Path)) {
            throw "Verification failed: a $EntryKind entry is missing."
        }
        $actualEntry = $actualByPath[$expectedEntry.Path]
        foreach ($propertyName in $Properties) {
            $expectedValue = $expectedEntry.$propertyName
            $actualValue = $actualEntry.$propertyName
            if ($null -eq $expectedValue -or $null -eq $actualValue) {
                if (-not ($null -eq $expectedValue -and $null -eq $actualValue)) {
                    throw "Verification failed: a $EntryKind property is missing."
                }
                continue
            }
            $expectedComparable = $expectedValue
            $actualComparable = $actualValue
            if ($expectedComparable -is [datetime]) {
                $expectedComparable = $expectedComparable.ToUniversalTime().ToString('o')
            }
            if ($actualComparable -is [datetime]) {
                $actualComparable = $actualComparable.ToUniversalTime().ToString('o')
            }
            if ($expectedComparable -is [string] -or $actualComparable -is [string]) {
                $comparison = [System.StringComparison]::OrdinalIgnoreCase
                if ($propertyName -eq 'Target') {
                    $comparison = [System.StringComparison]::Ordinal
                }
                if (-not [string]::Equals([string]$expectedComparable, [string]$actualComparable, $comparison)) {
                    throw "Verification failed: a $EntryKind property differs."
                }
            }
            elseif ($expectedValue -ne $actualValue) {
                throw "Verification failed: a $EntryKind property differs."
            }
        }
    }
}

function Compare-Inventory {
    param(
        $ExpectedRoot,
        $ActualRoot
    )
    $expected = Assert-InventoryArrays -Root $ExpectedRoot
    $actual = Assert-InventoryArrays -Root $ActualRoot
    Compare-EntryList -Expected $expected.Files -Actual $actual.Files -EntryKind 'file' -Properties @(
        'Path', 'Length', 'SHA256', 'Attributes', 'CreationTimeUtc', 'LastWriteTimeUtc'
    )
    Compare-EntryList -Expected $expected.Links -Actual $actual.Links -EntryKind 'link' -Properties @(
        'Path', 'Type', 'Target', 'Attributes', 'CreationTimeUtc', 'LastWriteTimeUtc'
    )
    Compare-EntryList -Expected $expected.Directories -Actual $actual.Directories -EntryKind 'directory' -Properties @(
        'Path', 'Attributes', 'CreationTimeUtc', 'LastWriteTimeUtc'
    )
    $expectedEmpty = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $expected.EmptyDirectories) { [void]$expectedEmpty.Add($path) }
    $actualEmpty = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $actual.EmptyDirectories) { [void]$actualEmpty.Add($path) }
    if ($expectedEmpty.Count -ne $actualEmpty.Count) {
        throw 'Verification failed: empty-directory count differs.'
    }
    foreach ($path in $expectedEmpty) {
        if (-not $actualEmpty.Contains($path)) {
            throw 'Verification failed: an empty-directory entry is missing.'
        }
    }

    $expectedRootProperties = @(
        'RootAttributes', 'RootCreationTimeUtc', 'RootLastWriteTimeUtc'
    )
    foreach ($propertyName in $expectedRootProperties) {
        $expectedValue = $ExpectedRoot.$propertyName
        $actualValue = $ActualRoot.$propertyName
        if ($expectedValue -is [datetime]) {
            $expectedValue = $expectedValue.ToUniversalTime().ToString('o')
        }
        if ($actualValue -is [datetime]) {
            $actualValue = $actualValue.ToUniversalTime().ToString('o')
        }
        if (-not [string]::Equals([string]$expectedValue, [string]$actualValue, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Verification failed: source-root metadata differs.'
        }
    }
}

function Set-PathTimestampsUtc {
    param(
        [string]$Path,
        [datetime]$CreationTimeUtc,
        [datetime]$LastWriteTimeUtc,
        [bool]$OpenReparsePoint = $false
    )
    $flags = if ($OpenReparsePoint) { [uint32]0x02200000 } else { [uint32]0x02000000 }
    $lastError = 0
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        $handle = [BackupDesktop.BackupDesktopNativeMethods]::CreateFile(
            $Path,
            [uint32]0x100,
            [uint32]7,
            [System.IntPtr]::Zero,
            [uint32]3,
            $flags,
            [System.IntPtr]::Zero)
        if ($null -ne $handle -and -not $handle.IsInvalid) {
            try {
                $succeeded = [BackupDesktop.BackupDesktopNativeMethods]::SetFileTimes(
                    $handle,
                    $CreationTimeUtc.ToFileTimeUtc(),
                    $LastWriteTimeUtc.ToFileTimeUtc())
                if (-not $succeeded) {
                    $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
                    throw "Unable to update entry timestamps (Win32 error $errorCode)."
                }
                return
            }
            finally {
                $handle.Dispose()
            }
        }
        $lastError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($lastError -ne 32 -or $attempt -eq 5) {
            throw "Unable to open path for timestamp update (Win32 error $lastError)."
        }
        Start-Sleep -Milliseconds (40 * $attempt)
    }
}

function Set-RootMetadataFromManifest {
    param(
        [string]$RootPath,
        $ManifestRoot
    )
    $item = Get-Item -LiteralPath $RootPath -Force
    $attributes = [System.Enum]::Parse([System.IO.FileAttributes], $ManifestRoot.RootAttributes, $true)
    $item.Attributes = $attributes
    Set-PathTimestampsUtc -Path $RootPath `
        -CreationTimeUtc ([datetime]::Parse($ManifestRoot.RootCreationTimeUtc, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)) `
        -LastWriteTimeUtc ([datetime]::Parse($ManifestRoot.RootLastWriteTimeUtc, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind))
}

function Convert-ManifestTimestamp {
    param($Value)
    if ($Value -is [datetime]) {
        return [datetime]$Value.ToUniversalTime()
    }
    return [datetime]::Parse([string]$Value, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
}

function Set-EntryMetadataFromManifest {
    param(
        [string]$RootPath,
        $Entry,
        [string]$EntryKind
    )
    $entryPath = Join-Path $RootPath $Entry.Path
    $item = Get-Item -LiteralPath $entryPath -Force
    $attributes = [System.Enum]::Parse([System.IO.FileAttributes], $Entry.Attributes, $true)
    $item.Attributes = $attributes
    $isReparse = (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    Set-PathTimestampsUtc -Path $entryPath `
        -CreationTimeUtc (Convert-ManifestTimestamp -Value $Entry.CreationTimeUtc) `
        -LastWriteTimeUtc (Convert-ManifestTimestamp -Value $Entry.LastWriteTimeUtc) `
        -OpenReparsePoint $isReparse
}

function Set-TreeMetadataFromManifest {
    param(
        [string]$RootPath,
        $ManifestRoot
    )
    foreach ($directory in @($ManifestRoot.Directories)) {
        Set-EntryMetadataFromManifest -RootPath $RootPath -Entry $directory -EntryKind 'directory'
    }
    foreach ($file in @($ManifestRoot.Files)) {
        Set-EntryMetadataFromManifest -RootPath $RootPath -Entry $file -EntryKind 'file'
    }
    foreach ($link in @($ManifestRoot.Links)) {
        Set-EntryMetadataFromManifest -RootPath $RootPath -Entry $link -EntryKind 'link'
    }
    Set-RootMetadataFromManifest -RootPath $RootPath -ManifestRoot $ManifestRoot
}

function Write-JsonFile {
    param(
        [string]$Path,
        $Value
    )
    Assert-BackupControlPath -Path $Path
    $json = ConvertTo-Json -InputObject $Value -Depth 8
    $temporaryPath = $Path + '.' + [System.Guid]::NewGuid().ToString('N') + '.tmp'
    $stream = [System.IO.File]::Open($temporaryPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
    $writer = New-Object System.IO.StreamWriter($stream, $script:Utf8NoBom)
    try { $writer.Write($json) } finally { $writer.Dispose() }
    if ([System.IO.File]::Exists($Path)) {
        $previousPath = $Path + '.previous-' + [System.Guid]::NewGuid().ToString('N')
        [System.IO.File]::Replace($temporaryPath, $Path, $previousPath)
    } else {
        [System.IO.File]::Move($temporaryPath, $Path)
    }
}

function Assert-BackupControlPath {
    param([string]$Path, [switch]$Directory)
    $final = Get-ExpectedFinalPath -Path $Path
    if (-not (Test-PathInside -ChildPath $final -ParentPath $backupFinalPath)) {
        throw 'A backup control path resolves outside the backup directory.'
    }
    if (Test-Path -LiteralPath $Path -PathType Any) {
        $item = Get-Item -LiteralPath $Path -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'A backup control path is a reparse point.'
        }
        if ([bool]$item.PSIsContainer -ne [bool]$Directory) {
            throw 'A backup control path has an unexpected file type.'
        }
    }
}

function Read-JsonFile {
    param([string]$Path)
    try {
        return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw 'Unable to read a required JSON file.'
    }
}

function Get-DesktopVersion {
    param([string]$RootPath)
    $executableCandidate = Join-Path $RootPath 'DSH Desktop.exe'
    if (Test-Path -LiteralPath $executableCandidate -PathType Leaf) {
        $versionInfo = (Get-Item -LiteralPath $executableCandidate).VersionInfo
        $version = $versionInfo.FileVersion
        if ([string]::IsNullOrWhiteSpace($version)) {
            $version = $versionInfo.ProductVersion
        }
        if (-not [string]::IsNullOrWhiteSpace($version)) {
            return $version
        }
    }

    $packageCandidate = Join-Path $RootPath 'package.json'
    if (Test-Path -LiteralPath $packageCandidate -PathType Leaf) {
        try {
            $package = Get-Content -LiteralPath $packageCandidate -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -ne $package.version -and -not [string]::IsNullOrWhiteSpace([string]$package.version)) {
                return [string]$package.version
            }
        }
        catch {
            return 'unknown'
        }
    }
    return 'unknown'
}

function Invoke-Robocopy {
    param(
        [string]$SourcePath,
        [string]$DestinationPath,
        [string]$LogPath
    )
    Assert-BackupControlPath -Path (Split-Path -Parent $LogPath) -Directory
    Assert-BackupControlPath -Path $LogPath
    if (-not (Test-Path -LiteralPath $DestinationPath -PathType Container)) {
        New-Item -ItemType Directory -Path $DestinationPath | Out-Null
    }
    $robocopyPath = Join-Path $env:SystemRoot 'System32\Robocopy.exe'
    if (-not (Test-Path -LiteralPath $robocopyPath -PathType Leaf)) {
        throw 'Robocopy is unavailable.'
    }
    $arguments = @(
        $SourcePath,
        $DestinationPath,
        '/E',
        '/COPY:DAT',
        '/DCOPY:DAT',
        '/SJ',
        '/SL',
        '/R:1',
        '/W:1',
        '/NFL',
        '/NDL',
        '/NJH',
        '/NJS',
        '/NP',
        "/UNILOG:$LogPath"
    )
    & $robocopyPath @arguments > $null 2> $null
    $exitCode = $LASTEXITCODE
    if ($exitCode -ge 8) {
        throw "Robocopy failed with exit code $exitCode."
    }
}

function Write-Summary {
    param(
        [string]$Mode,
        [string]$Status,
        $Manifest
    )
    Write-Host "[$($Mode.ToUpperInvariant())] status=$Status"
    if ($null -ne $Manifest) {
        foreach ($root in @($Manifest.Roots)) {
            Write-Host ("{0}: files={1} links={2} directories={3} empty-directories={4} bytes={5}" -f $root.Name.ToUpperInvariant(), $root.FileCount, $root.LinkCount, $root.DirectoryCount, $root.EmptyDirectoryCount, $root.TotalBytes)
        }
        Write-Host ("TOTAL: files={0} links={1} directories={2} bytes={3}" -f $Manifest.Totals.FileCount, $Manifest.Totals.LinkCount, $Manifest.Totals.DirectoryCount, $Manifest.Totals.TotalBytes)
        Write-Host "VERSION=$($Manifest.Version)"
    }
}

if (Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue) {
    throw 'DSH Desktop is running: quit it completely and retry; no process was stopped.'
}

$projectPath = Get-NormalizedFullPath -Path (Join-Path $PSScriptRoot '..\..')
$projectFinalPath = Get-FinalPath -Path $projectPath
$testWorkPath = Get-NormalizedFullPath -Path (Join-Path $projectPath 'test-work')
$testWorkFinalPath = Get-FinalPath -Path $testWorkPath

$isTestMode = (-not [string]::IsNullOrWhiteSpace($ProgramDir) -or -not [string]::IsNullOrWhiteSpace($DataDir))
if ($isTestMode -and ([string]::IsNullOrWhiteSpace($ProgramDir) -or [string]::IsNullOrWhiteSpace($DataDir))) {
    throw 'Both -ProgramDir and -DataDir must be omitted for daily targets or supplied for test-work fixtures.'
}
if (-not $isTestMode) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or [string]::IsNullOrWhiteSpace($env:APPDATA)) {
        throw 'Required user environment paths are unavailable.'
    }
    $ProgramDir = Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop'
    $DataDir = Join-Path $env:APPDATA 'dsh-desktop'
}

$programFull = Get-NormalizedFullPath -Path $ProgramDir
$dataFull = Get-NormalizedFullPath -Path $DataDir
if ($isTestMode) {
    if (-not (Test-PathInside -ChildPath $programFull -ParentPath $testWorkPath) -or
        -not (Test-PathInside -ChildPath $dataFull -ParentPath $testWorkPath)) {
        throw 'Custom source paths must both be under the project test-work directory.'
    }
}

$sourceRoots = @()
foreach ($sourceDefinition in @(
    @{ Name = 'program'; Path = $programFull },
    @{ Name = 'data'; Path = $dataFull }
)) {
    if (-not (Test-Path -LiteralPath $sourceDefinition.Path -PathType Container)) {
        throw "The $($sourceDefinition.Name) source directory does not exist."
    }
    $sourceItem = Get-Item -LiteralPath $sourceDefinition.Path -Force
    if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "The $($sourceDefinition.Name) source root is a reparse point."
    }
    $sourceFinalPath = Get-FinalPath -Path $sourceDefinition.Path
    $sourceRoots += [pscustomobject]@{
        Name = $sourceDefinition.Name
        OriginalPath = $sourceDefinition.Path
        ResolvedPath = $sourceFinalPath
    }
}

if ((Test-SamePath -LeftPath $sourceRoots[0].ResolvedPath -RightPath $sourceRoots[1].ResolvedPath) -or
    ((Test-PathInside -ChildPath $sourceRoots[0].ResolvedPath -ParentPath $sourceRoots[1].ResolvedPath)) -or
    ((Test-PathInside -ChildPath $sourceRoots[1].ResolvedPath -ParentPath $sourceRoots[0].ResolvedPath))) {
    throw 'The program and data source roots must not be equal or nested.'
}

$backupFull = Get-NormalizedFullPath -Path $BackupDir
$backupExists = Test-Path -LiteralPath $backupFull -PathType Any
if ($Restore) {
    if (-not $backupExists) {
        throw 'The backup directory does not exist.'
    }
    if (-not (Test-Path -LiteralPath $backupFull -PathType Container)) {
        throw 'The backup path is occupied by a file.'
    }
    $backupItem = Get-Item -LiteralPath $backupFull -Force
    if (($backupItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The backup root is a reparse point.'
    }
} elseif ($backupExists) {
    throw 'The backup directory already exists.'
}
$backupFinalPath = Get-ExpectedFinalPath -Path $backupFull

$sourcesAreTestFixtures = $true
foreach ($sourceRoot in $sourceRoots) {
    $literalInside = Test-PathInside -ChildPath $sourceRoot.OriginalPath -ParentPath $testWorkPath
    $finalInside = Test-PathInside -ChildPath $sourceRoot.ResolvedPath -ParentPath $testWorkFinalPath
    if (-not ($literalInside -and $finalInside)) {
        $sourcesAreTestFixtures = $false
    }
}

if ($isTestMode -and -not $sourcesAreTestFixtures) {
    throw 'Custom source paths must remain under the project test-work directory after resolving all ancestors.'
}

$backupLiteralInsideProject = Test-PathInside -ChildPath $backupFull -ParentPath $projectPath
$backupFinalInsideProject = Test-PathInside -ChildPath $backupFinalPath -ParentPath $projectFinalPath
if ($sourcesAreTestFixtures) {
    $backupLiteralInsideTestWork = Test-PathInside -ChildPath $backupFull -ParentPath $testWorkPath
    $backupFinalInsideTestWork = Test-PathInside -ChildPath $backupFinalPath -ParentPath $testWorkFinalPath
    if (-not ($backupLiteralInsideTestWork -and $backupFinalInsideTestWork)) {
        throw 'Test-fixture backups must also be under the project test-work directory.'
    }
} elseif ($backupLiteralInsideProject -or $backupFinalInsideProject) {
    throw 'Daily backups must not be inside the project directory.'
}

foreach ($sourceRoot in $sourceRoots) {
    if ((Test-SamePath -LeftPath $backupFinalPath -RightPath $sourceRoot.ResolvedPath) -or
        ((Test-PathInside -ChildPath $backupFinalPath -ParentPath $sourceRoot.ResolvedPath)) -or
        ((Test-PathInside -ChildPath $sourceRoot.ResolvedPath -ParentPath $backupFinalPath))) {
        throw 'The backup directory must not equal or overlap either source root.'
    }
}

$manifestPath = Join-Path $backupFull 'manifest.json'
$statusPath = Join-Path $backupFull 'status.json'
$logDirectory = Join-Path $backupFull 'logs'

if ($Restore) {
    # EFS on a destination parent can prevent a directory move or encrypt a
    # newly created field. Reject before hashing or moving either source tree.
    foreach ($restoreRoot in $sourceRoots) {
        $restoreParent = [System.IO.Path]::GetDirectoryName($restoreRoot.OriginalPath)
        if (([System.IO.File]::GetAttributes($restoreParent) -band [System.IO.FileAttributes]::Encrypted) -ne 0) {
            throw 'A restore parent uses EFS encryption. No source directory was moved; restore requires a user session with the matching EFS key.'
        }
    }
    # Reject redirected control paths before reading inventories or moving roots.
    Assert-BackupControlPath -Path $manifestPath
    Assert-BackupControlPath -Path $statusPath
    Assert-BackupControlPath -Path (Join-Path $backupFull 'restore-status.json')
    Assert-BackupControlPath -Path $logDirectory -Directory
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $statusPath -PathType Leaf)) {
        throw 'The backup is incomplete because its manifest or success status is missing.'
    }
    $manifest = Read-JsonFile -Path $manifestPath
    Assert-Manifest -Manifest $manifest

    $status = Read-JsonFile -Path $statusPath
    $manifestJson = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8
    $manifestHash = Get-StringSha256 -Value $manifestJson
    if ($status.Status -ne 'Success' -or $status.ManifestSHA256 -ne $manifestHash) {
        throw 'The backup success status does not match its manifest.'
    }

    foreach ($sourceRoot in $sourceRoots) {
        $manifestRoot = @($manifest.Roots) | Where-Object { $_.Name -eq $sourceRoot.Name }
        if ($null -eq $manifestRoot -or @($manifestRoot).Count -ne 1) {
            throw 'The backup manifest does not contain exactly one record for each expected source root.'
        }
        $manifestRoot = @($manifestRoot)[0]
        if (-not (Test-SamePath -LeftPath $manifestRoot.OriginalPath -RightPath $sourceRoot.OriginalPath) -or
            -not (Test-SamePath -LeftPath $manifestRoot.ResolvedPath -RightPath $sourceRoot.ResolvedPath)) {
            throw 'The backup manifest source paths do not match this machine and the selected targets.'
        }
        $backupRootPath = Join-Path $backupFinalPath $sourceRoot.Name
        if (-not (Test-Path -LiteralPath $backupRootPath -PathType Container)) {
            throw 'A backup source root is missing.'
        }
        $backupRootItem = Get-Item -LiteralPath $backupRootPath -Force
        if (($backupRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'A backup source root is a reparse point.'
        }
        $backupInventory = Get-TreeInventory -RootPath $backupRootPath -CalculateHashes $true
        Compare-Inventory -ExpectedRoot $manifestRoot -ActualRoot $backupInventory
    }

    if (-not $Execute) {
        Write-Summary -Mode 'restore' -Status 'preview-valid' -Manifest $manifest
        Write-Host 'RESULT=no changes'
        exit 0
    }

    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $runSuffix = [System.Guid]::NewGuid().ToString('N').Substring(0, 8)
    $fieldTargets = @()
    foreach ($sourceRoot in $sourceRoots) {
        $parentPath = [System.IO.Path]::GetDirectoryName($sourceRoot.OriginalPath)
        if (([System.IO.File]::GetAttributes($parentPath) -band [System.IO.FileAttributes]::Encrypted) -ne 0) {
            throw 'A restore parent uses EFS encryption. No source directory was moved; restore requires a user session with the matching EFS key.'
        }
        $leafName = [System.IO.Path]::GetFileName($sourceRoot.OriginalPath)
        $fieldPath = Join-Path $parentPath ("$leafName.pre-restore-$timestamp-$runSuffix")
        if (Test-Path -LiteralPath $fieldPath -PathType Any) {
            throw 'A timestamped field directory path is already occupied.'
        }
        $fieldTargets += [pscustomobject]@{
            Name = $sourceRoot.Name
            SourcePath = $sourceRoot.OriginalPath
            FieldPath = $fieldPath
        }
    }

    $firstMoved = $false
    try {
        [System.IO.Directory]::Move($fieldTargets[0].SourcePath, $fieldTargets[0].FieldPath)
        $firstMoved = $true
        [System.IO.Directory]::Move($fieldTargets[1].SourcePath, $fieldTargets[1].FieldPath)
    }
    catch {
        if ($firstMoved) {
            throw 'Restore stopped after moving the first source root; the moved field directory was retained.'
        }
        throw
    }

    if (-not (Test-Path -LiteralPath $logDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $logDirectory | Out-Null
    }
    foreach ($sourceRoot in $sourceRoots) {
        $manifestRoot = @($manifest.Roots) | Where-Object { $_.Name -eq $sourceRoot.Name }
        $backupRootPath = Join-Path $backupFinalPath $sourceRoot.Name
        $restoreLogPath = Join-Path $logDirectory ("restore-$timestamp-$runSuffix-$($sourceRoot.Name).log")
        Invoke-Robocopy -SourcePath $backupRootPath -DestinationPath $sourceRoot.OriginalPath -LogPath $restoreLogPath
        Set-TreeMetadataFromManifest -RootPath $sourceRoot.OriginalPath -ManifestRoot $manifestRoot
    }

    foreach ($sourceRoot in $sourceRoots) {
        $manifestRoot = @($manifest.Roots) | Where-Object { $_.Name -eq $sourceRoot.Name }
        $restoredInventory = Get-TreeInventory -RootPath $sourceRoot.OriginalPath -CalculateHashes $true
        Compare-Inventory -ExpectedRoot $manifestRoot -ActualRoot $restoredInventory
    }

    $restoreStatus = [pscustomobject]@{
        Status = 'Success'
        RestoredAtUtc = [datetime]::UtcNow.ToString('o')
        ManifestSHA256 = $manifestHash
    }
    Write-JsonFile -Path (Join-Path $backupFull 'restore-status.json') -Value $restoreStatus
    Write-Summary -Mode 'restore' -Status 'completed' -Manifest $manifest
    Write-Host 'FIELD_DIRECTORIES=retained'
    exit 0
}

$programPreview = Get-TreeInventory -RootPath $programFull -CalculateHashes $false
$dataPreview = Get-TreeInventory -RootPath $dataFull -CalculateHashes $false
$desktopVersion = Get-DesktopVersion -RootPath $programFull

$previewManifest = [pscustomobject]@{
    ManifestVersion = 1
    Preview = $true
    Totals = [pscustomobject]@{
        FileCount = $programPreview.FileCount + $dataPreview.FileCount
        LinkCount = $programPreview.LinkCount + $dataPreview.LinkCount
        DirectoryCount = $programPreview.DirectoryCount + $dataPreview.DirectoryCount
        TotalBytes = [int64]$programPreview.TotalBytes + [int64]$dataPreview.TotalBytes
    }
    Version = $desktopVersion
}
if (-not $Execute) {
    Write-Host '[BACKUP] status=preview-valid'
    Write-Host ("PROGRAM: files={0} links={1} directories={2} empty-directories={3} bytes={4}" -f $programPreview.FileCount, $programPreview.LinkCount, $programPreview.DirectoryCount, $programPreview.EmptyDirectoryCount, $programPreview.TotalBytes)
    Write-Host ("DATA: files={0} links={1} directories={2} empty-directories={3} bytes={4}" -f $dataPreview.FileCount, $dataPreview.LinkCount, $dataPreview.DirectoryCount, $dataPreview.EmptyDirectoryCount, $dataPreview.TotalBytes)
    Write-Host ("TOTAL: files={0} links={1} directories={2} bytes={3}" -f $previewManifest.Totals.FileCount, $previewManifest.Totals.LinkCount, $previewManifest.Totals.DirectoryCount, $previewManifest.Totals.TotalBytes)
    Write-Host "VERSION=$desktopVersion"
    Write-Host 'RESULT=no changes'
    exit 0
}

$programInventory = Get-TreeInventory -RootPath $programFull -CalculateHashes $true
$dataInventory = Get-TreeInventory -RootPath $dataFull -CalculateHashes $true
$manifestRoots = @(
    [pscustomobject]@{
        Name = 'program'
        OriginalPath = $programFull
        ResolvedPath = $sourceRoots[0].ResolvedPath
        RootAttributes = $programInventory.RootAttributes
        RootCreationTimeUtc = $programInventory.RootCreationTimeUtc
        RootLastWriteTimeUtc = $programInventory.RootLastWriteTimeUtc
        Files = $programInventory.Files
        Links = $programInventory.Links
        Directories = $programInventory.Directories
        EmptyDirectories = $programInventory.EmptyDirectories
        FileCount = $programInventory.FileCount
        LinkCount = $programInventory.LinkCount
        DirectoryCount = $programInventory.DirectoryCount
        EmptyDirectoryCount = $programInventory.EmptyDirectoryCount
        TotalBytes = $programInventory.TotalBytes
    },
    [pscustomobject]@{
        Name = 'data'
        OriginalPath = $dataFull
        ResolvedPath = $sourceRoots[1].ResolvedPath
        RootAttributes = $dataInventory.RootAttributes
        RootCreationTimeUtc = $dataInventory.RootCreationTimeUtc
        RootLastWriteTimeUtc = $dataInventory.RootLastWriteTimeUtc
        Files = $dataInventory.Files
        Links = $dataInventory.Links
        Directories = $dataInventory.Directories
        EmptyDirectories = $dataInventory.EmptyDirectories
        FileCount = $dataInventory.FileCount
        LinkCount = $dataInventory.LinkCount
        DirectoryCount = $dataInventory.DirectoryCount
        EmptyDirectoryCount = $dataInventory.EmptyDirectoryCount
        TotalBytes = $dataInventory.TotalBytes
    }
)
$manifest = [pscustomobject]@{
    ManifestVersion = 1
    CreatedAtUtc = [datetime]::UtcNow.ToString('o')
    ScriptVersion = $script:ScriptVersion
    Version = $desktopVersion
    Roots = $manifestRoots
    Totals = [pscustomobject]@{
        FileCount = $programInventory.FileCount + $dataInventory.FileCount
        LinkCount = $programInventory.LinkCount + $dataInventory.LinkCount
        DirectoryCount = $programInventory.DirectoryCount + $dataInventory.DirectoryCount
        TotalBytes = [int64]$programInventory.TotalBytes + [int64]$dataInventory.TotalBytes
    }
}
Assert-Manifest -Manifest $manifest

New-Item -ItemType Directory -Path $backupFull | Out-Null
New-Item -ItemType Directory -Path $logDirectory | Out-Null
Write-JsonFile -Path $manifestPath -Value $manifest

foreach ($copyRoot in @(
    @{ Name = 'program'; Source = $programFull },
    @{ Name = 'data'; Source = $dataFull }
)) {
    $destinationRoot = Join-Path $backupFinalPath $copyRoot.Name
    $copyLogPath = Join-Path $logDirectory ("backup-$($copyRoot.Name).log")
    Invoke-Robocopy -SourcePath $copyRoot.Source -DestinationPath $destinationRoot -LogPath $copyLogPath
    $manifestRoot = @($manifest.Roots) | Where-Object { $_.Name -eq $copyRoot.Name }
    Set-TreeMetadataFromManifest -RootPath $destinationRoot -ManifestRoot $manifestRoot
}

$backupInventories = @()
foreach ($sourceRoot in $sourceRoots) {
    $backupRootPath = Join-Path $backupFinalPath $sourceRoot.Name
    $backupInventory = Get-TreeInventory -RootPath $backupRootPath -CalculateHashes $true
    $manifestRoot = @($manifest.Roots) | Where-Object { $_.Name -eq $sourceRoot.Name }
    Compare-Inventory -ExpectedRoot $manifestRoot -ActualRoot $backupInventory
}

$manifestHash = Get-StringSha256 -Value (Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8)
$status = [pscustomobject]@{
    Status = 'Success'
    CompletedAtUtc = [datetime]::UtcNow.ToString('o')
    ManifestSHA256 = $manifestHash
    ScriptVersion = $script:ScriptVersion
}
Write-JsonFile -Path $statusPath -Value $status
Write-Summary -Mode 'backup' -Status 'completed' -Manifest $manifest
exit 0
