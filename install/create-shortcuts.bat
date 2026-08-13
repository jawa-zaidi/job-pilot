@echo off
REM Puts a JobPilot shortcut on your Desktop and in the Start Menu.
REM Double-click this file. Nothing to type.
cscript //nologo "%~dp0create-shortcuts.vbs"
exit /b %ERRORLEVEL%
