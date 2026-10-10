@echo off
setlocal
cd /d "%~dp0"
set PLAYWRIGHT_BROWSERS_PATH=%~dp0browsers
set JEV_BACKEND=local
"%~dp0node.exe" "%~dp0src\server.js" %*
if errorlevel 1 pause
endlocal