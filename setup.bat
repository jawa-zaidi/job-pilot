@echo off
REM JobPilot one-command setup for Windows: run setup.bat
REM
REM This still works exactly as it always did. If you'd rather not use a
REM command prompt at all, just double-click JobPilot.bat instead - same thing.
REM
REM The real work lives in install\preflight.bat + install\launch.js, which
REM every way of starting JobPilot shares.
call "%~dp0install\preflight.bat" %*
exit /b %ERRORLEVEL%
