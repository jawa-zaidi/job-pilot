@echo off
REM JobPilot one-command setup for Windows: double-click or run setup.bat
cd /d "%~dp0"
echo.
echo   JobPilot setup
echo   --------------
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed.
  echo   Download the LTS version from https://nodejs.org , install it,
  echo   then run setup.bat again.
  pause
  exit /b 1
)
if exist .git (
  where git >nul 2>nul && (
    echo   Checking for updates...
    git pull --ff-only
  )
)
call npm install --silent
if "%JOBPILOT_DATA%"=="" (set DATA_DIR=%USERPROFILE%\JobPilotData) else (set DATA_DIR=%JOBPILOT_DATA%)
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
echo.
echo   Your data folder: %DATA_DIR%
echo   Back this folder up. Copy it to a new device + run setup there,
echo   and all your data comes with you.
echo.
echo   Opening http://localhost:4310 ... (keep this window open)
start "" http://localhost:4310
call npm start
