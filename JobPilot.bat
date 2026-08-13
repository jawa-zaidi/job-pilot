@echo off
REM JobPilot - double-click this file to start.
REM Everything else happens by itself.
title JobPilot
set "JP_PAUSE_ON_EXIT=1"
call "%~dp0install\preflight.bat" %*
exit /b %ERRORLEVEL%
