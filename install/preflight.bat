@echo off
REM JobPilot preflight (Windows).
REM
REM The single shared entry point for every Windows way of starting JobPilot:
REM JobPilot.bat, the Desktop/Start Menu shortcut and setup.bat all end up here.
REM Its only job is to find Node.js - everything after that lives in launch.js,
REM which is the same code macOS uses.
REM
REM Set JP_PAUSE_ON_EXIT=1 to hold the window open after an error.

setlocal EnableExtensions

REM Switch the console to UTF-8 so the launcher's ticks and arrows render as
REM characters rather than mojibake on older Windows consoles. Harmless if it
REM fails - this file itself is plain ASCII.
chcp 65001 >nul 2>nul

set "JP_INSTALL=%~dp0"
pushd "%~dp0.."
if errorlevel 1 (
  echo.
  echo   Could not open the JobPilot folder.
  pause
  exit /b 1
)

set "JP_NODE="
where node >nul 2>nul && set "JP_NODE=node"
if not defined JP_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "JP_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined JP_NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "JP_NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined JP_NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "JP_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined JP_NODE goto :nonode

"%JP_NODE%" "%JP_INSTALL%launch.js" %*
set "JP_STATUS=%ERRORLEVEL%"
popd

if not "%JP_STATUS%"=="0" if "%JP_PAUSE_ON_EXIT%"=="1" pause
exit /b %JP_STATUS%

:nonode
echo.
echo   JobPilot
echo   --------
echo.
echo   JobPilot needs one free program first: Node.js
echo.
echo   Node.js is what actually runs JobPilot on your computer. It is made by
echo   a non-profit foundation, it is free, and you only ever install it once.
echo.
echo   We just opened nodejs.org in your browser. There:
echo.
echo     1. Click the big green button that says "LTS" - that means "stable".
echo     2. Open the file it downloads and click Next until it finishes.
echo     3. Close this window, then double-click JobPilot again.
echo.
echo   That's it - nothing to type, and you won't see this message again.
echo.
start "" "https://nodejs.org/en/download"
popd
pause
exit /b 1
