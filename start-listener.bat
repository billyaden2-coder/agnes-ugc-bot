@echo off
title Agnes Listener
cd /d "%~dp0"
node listener.mjs
echo.
echo Listener stopped. Press any key to close.
pause >nul