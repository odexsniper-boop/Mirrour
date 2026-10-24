@echo off
title Odex Mirror - restart
cd /d "%~dp0"
echo Stopping the server...
rem stop the auto-restart window first (otherwise it would start the server again)
taskkill /FI "WINDOWTITLE eq Odex Mirror server*" /T /F >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3400 ^| findstr LISTENING') do taskkill /PID %%a /F >nul 2>&1
timeout /t 1 /nobreak >nul
echo Starting Odex Mirror (auto-restart on)...
start "Odex Mirror server" /min cmd /c run-server.bat
exit
