@echo off
echo Stopping OptiLens Local...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8080" ^| findstr "LISTENING"') do (
    echo Killing PID %%a
    taskkill /F /PID %%a 2>nul
)
timeout /t 2 /nobreak >nul
echo Starting OptiLens Local...
cd /d C:\DEV\optilens-local
start "" /B node server.js
echo Done. Server restarting on port 8080.
