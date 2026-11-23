# Launches the local 127.0.0.1 visual configurator for LeaderTeam member models, candidate pool, and governance roles.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\open-model-config.ps1 [-Port 0] [-NoOpen]
param(
    [int]$Port = 0,
    [switch]$NoOpen,
    [string]$Config,
    [string]$DshHome
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js (>= 22.15) was not found on PATH.' }

$cli = Join-Path $PSScriptRoot 'configure-models.mjs'
$argsList = @($cli, '--serve', '--port', [string]$Port)
if (-not $NoOpen) { $argsList += '--open' }
if ($Config) { $argsList += @('--config', $Config) }
if ($DshHome) { $argsList += @('--dsh-home', $DshHome) }

& $node @argsList
