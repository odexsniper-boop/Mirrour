@echo off
title Odex Mirror - restart
cd /d "%~dp0"
echo Stopping the server on port 3400...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3400 ^| findstr LISTENING') do taskkill /PID %%a /F >nul 2>&1
timeout /t 1 /nobreak >nul
echo Starting Odex Mirror...
start "Odex Mirror server" cmd /k npm start
exit
