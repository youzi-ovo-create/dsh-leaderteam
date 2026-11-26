@echo off
setlocal EnableExtensions
title LeaderTeam One-Click Graphical Installer

set "SCRIPT_DIR=%~dp0"
set "INSTALLER_JS=%SCRIPT_DIR%bin\lt-installer.mjs"

if not exist "%INSTALLER_JS%" (
  echo [ERROR] Missing "%INSTALLER_JS%". Please extract the full package first.
  pause
  exit /b 1
)

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  node "%INSTALLER_JS%" --gui %*
  exit /b %ERRORLEVEL%
)

REM Fallback: Reuse Official DeepSeek Harness Desktop's embedded Node runtime when standalone Node.js is not installed!
set "DSH_EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
if exist "%DSH_EXE%" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%DSH_EXE%" "%INSTALLER_JS%" --gui %*
  exit /b %ERRORLEVEL%
)

set "DSH_EXE_PF=%ProgramFiles%\DeepSeek Harness\DeepSeek Harness.exe"
if exist "%DSH_EXE_PF%" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%DSH_EXE_PF%" "%INSTALLER_JS%" --gui %*
  exit /b %ERRORLEVEL%
)

echo [LeaderTeam] Node.js or Official DeepSeek Harness Desktop was not detected on this computer.
echo Please install Official DeepSeek Harness Desktop first, then double-click this installer again.
pause
exit /b 1
