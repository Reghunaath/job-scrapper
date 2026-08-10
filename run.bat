@echo off
setlocal
title Job Scraper

REM Run from this script's own folder, so double-clicking works from anywhere.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Node.js was not found on your PATH.
    echo   Install it from https://nodejs.org and run this again.
    echo.
    pause
    exit /b 1
)

echo.
echo   Job scraper starting on http://localhost:5173
echo   Your browser will open in a moment.
echo.
echo   Leave this window open. Press Ctrl+C to stop the server.
echo.

REM Open the browser from a separate hidden process, after a short pause to let
REM the server bind the port. Running it inline would block the server start.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:5173'"

node server.js

echo.
echo   Server stopped.
pause
