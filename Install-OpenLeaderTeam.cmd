@echo off
setlocal EnableExtensions
title Open Leader Team (OLT) One-Click Graphical Installer

call "%~dp0Install-LeaderTeam.cmd" %*
exit /b %ERRORLEVEL%
