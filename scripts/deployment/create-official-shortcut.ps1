# Creates the explicit LeaderTeam entry without changing global environment.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$pathsFile = Join-Path $root 'config\official-desktop.paths.json'
if (-not (Test-Path -LiteralPath $pathsFile -PathType Leaf)) {
    throw 'Missing config\official-desktop.paths.json. Copy config\official-desktop.paths.example.json to config\official-desktop.paths.json first.'
}
$paths = Get-Content -LiteralPath $pathsFile -Raw -Encoding UTF8 | ConvertFrom-Json
$exe = Join-Path $paths.app 'DeepSeek Harness.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Official app must be installed before creating its shortcut.' }
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop -or -not (Test-Path -LiteralPath $desktop -PathType Container)) { throw 'Current user Desktop is unavailable.' }
$shortcutPath = Join-Path $desktop 'DeepSeek Harness - LeaderTeam.lnk'
if (Test-Path -LiteralPath $shortcutPath) { throw 'LeaderTeam shortcut already exists; inspect it before replacing.' }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root 'scripts\start-official-desktop.ps1') + '"'
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = $exe + ',0'
$shortcut.Description = 'DeepSeek official Desktop with LeaderTeam and local Magpie'
$shortcut.WindowStyle = 7
$shortcut.Save()
$verified = $shell.CreateShortcut($shortcutPath)
[pscustomobject]@{shortcut=$shortcutPath;target=$verified.TargetPath;arguments=$verified.Arguments;workingDirectory=$verified.WorkingDirectory;icon=$verified.IconLocation} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'reports\official-production-shortcut.json') -Encoding UTF8
Write-Output $shortcutPath
