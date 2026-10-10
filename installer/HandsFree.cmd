@echo off
setlocal
cd /d "%~dp0"
set PLAYWRIGHT_BROWSERS_PATH=%~dp0browsers
set JEV_BACKEND=local

set PORT=8787
set ARGS=%*
:parse
if "%~1"=="" goto run
if /i "%~1"=="--port" (set PORT=%~2 & shift & shift & goto parse)
shift
goto parse

:run
; server gets its own window so this one can wait for the port and open the UI
start "HandsFree server" "%~dp0node.exe" "%~dp0src\server.js" %*
for /l %%i in (1,1,60) do (
  ping -n 2 127.0.0.1 >nul
  netstat -ano | find "127.0.0.1:%PORT%" | find "LISTENING" >nul && (
    start "" "http://localhost:%PORT%"
    exit /b 0
  )
)
echo HandsFree did not open port %PORT%. Close the "HandsFree server" window to see the error.
pause