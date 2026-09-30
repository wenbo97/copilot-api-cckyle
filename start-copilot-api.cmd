@echo off
echo ================================================
echo GitHub Copilot API Server with Usage Viewer
echo Start Copilot API Server at %~dp0
echo ================================================
echo.

@REM curl cip.cc

ECHO Starting Copilot-Api service...

set COPILOT_CACHE_DIAGNOSTICS=1
cd /d "%~dp0" || exit /b 1
bun run dev:cache

pause
