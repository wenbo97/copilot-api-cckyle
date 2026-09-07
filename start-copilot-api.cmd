@echo off
echo ================================================
echo GitHub Copilot API Server with Usage Viewer
echo Start Copilot API Server at %~dp0
echo ================================================
echo.

@REM curl cip.cc

ECHO Starting Copilot-Api service...

cd /d "%~dp0" || exit /b 1
bun run dev:cache

pause
