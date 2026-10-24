@echo off
setlocal
echo ================================================
echo GitHub Copilot API Server with Usage Viewer
echo Start Copilot API Server at %~dp0
echo ================================================
echo.

@REM curl cip.cc

ECHO Starting Copilot-Api service...
cd /d "%~dp0" || exit /b 1
set "COPILOT_CACHE_DIAGNOSTICS=1"
set "TRACE_OUTPUT_FOLDER=%~dp0traces\cache-%RANDOM%-%RANDOM%"

echo Stop the existing proxy with Ctrl+C before running this script.
echo Log file: "%~dp0tmps\cache-session.log"
echo Trace folder: "%TRACE_OUTPUT_FOLDER%"
echo WARNING: Logs and traces may contain private conversations and code.
echo.

call bun run dev:cache --trace --trace-folder "%TRACE_OUTPUT_FOLDER%"
set "RESULT=%ERRORLEVEL%"
pause
exit /b %RESULT%
