@echo off
title Odex Mirror server
cd /d "%~dp0"
if not exist data mkdir data
rem Keeps the server running: if it ever stops or crashes it starts again after 5 seconds.
rem Everything it prints is also saved to data\server.log (so a crash reason is never lost).
:loop
echo [%date% %time%] starting Odex Mirror >> data\server.log
node server.mjs >> data\server.log 2>&1
echo [%date% %time%] server stopped (exit code %errorlevel%) - restarting in 5 seconds >> data\server.log
echo Server stopped (exit code %errorlevel%) - restarting in 5 seconds. See data\server.log
timeout /t 5 /nobreak >nul
goto loop
