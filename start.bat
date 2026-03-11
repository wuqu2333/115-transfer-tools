@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File "%SCRIPT_DIR%start.ps1"
endlocal
