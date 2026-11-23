# Installs the pinned signed official app to a new independent directory.
param([string]$Installer, [string]$PathsFile, [switch]$Execute)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $PathsFile) { $PathsFile = Join-Path $root 'config\official-desktop.paths.json' }
if (-not (Test-Path -LiteralPath $PathsFile -PathType Leaf)) {
    throw 'Missing config\official-desktop.paths.json. Copy config\official-desktop.paths.example.json to config\official-desktop.paths.json first.'
}
$paths = Get-Content -LiteralPath $PathsFile -Raw -Encoding UTF8 | ConvertFrom-Json
$installer = if ($Installer) { [IO.Path]::GetFullPath($Installer) } else { Join-Path $root 'runtime\official-desktop\downloads\dsh-latest-windows-x64.exe' }
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Official 0.2.2-rc.1 installer not found at '$installer'. Pass -Installer <path-to-dsh-windows-x64.exe>."
}
$expectedHash = '830947F8996DC05D991CA9133FFF4D3400073E47B9CFA6507754867E79482B23'
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Official installer hash mismatch.' }
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Hangzhou DeepSeek Artificial Intelligence Co\., Ltd\.') { throw 'Official installer signature mismatch.' }
foreach ($target in @($paths.app,$paths.home,$paths.userData)) {
    if (-not [IO.Path]::IsPathRooted($target) -or $target -match '["\r\n\x00]') { throw 'Invalid installation path.' }
    $ancestor = [IO.Path]::GetFullPath($target)
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if (($item.Attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Encrypted)) -ne 0) { throw 'Installation/data ancestors must not use links or EFS.' }
        }
        $parent = Split-Path -Parent $ancestor
        if (-not $parent -or $parent -eq $ancestor) { break }
        $ancestor = $parent
    }
}
if (Test-Path -LiteralPath $paths.app) { throw 'The new official installation target must not already exist.' }
if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) { throw 'Quit the isolated official Desktop before installing.' }
$preview = [pscustomobject]@{installer=$installer;sha256=$expectedHash;signature='Valid';app=$paths.app;home=$paths.home;userData=$paths.userData;execute=[bool]$Execute}
if (-not $Execute) { $preview | ConvertTo-Json; return }
$priorNodeMode = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE','Process')
$priorDshHome = [Environment]::GetEnvironmentVariable('DSH_HOME','Process')
try {
    [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE',$null,'Process')
    $env:DSH_HOME = $paths.home
    $process = Start-Process -FilePath $installer -ArgumentList @('/S',('/D=' + $paths.app)) -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Official installer failed with code $($process.ExitCode). The new target is preserved for inspection." }
} finally {
    [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE',$priorNodeMode,'Process')
    [Environment]::SetEnvironmentVariable('DSH_HOME',$priorDshHome,'Process')
}
$runtime = & node (Join-Path $root 'scripts\dsh-runtime.mjs') --json --app $paths.app
if ($LASTEXITCODE -ne 0) { throw 'Installed official artifact verification failed.' }
$verified = ($runtime -join "`n") | ConvertFrom-Json
if ($verified.kind -ne 'official-desktop' -or $verified.version -ne '0.2.2-rc.1') { throw 'Installed official version mismatch.' }
$unexpected = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" | Where-Object { $_.ExecutablePath -ieq $verified.exe })
$result = [pscustomobject]@{installedAt=(Get-Date -Format o);installerSHA256=$expectedHash;installerExit=0;runtime=$verified;unexpectedDesktopProcesses=$unexpected.Count;paths=$paths}
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root 'reports\official-production-install.json') -Encoding UTF8
$result | ConvertTo-Json -Depth 8
if ($unexpected.Count) { throw 'Silent installer unexpectedly started Desktop; inspect the verified own process before continuing.' }
