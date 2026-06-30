@ECHO OFF
set ANTHROPIC_BASE_URL=http://localhost:4141
set ANTHROPIC_AUTH_TOKEN=dummy
set CLAUDE_CODE_ATTRIBUTION_HEADER=0
set CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1
set CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=88
set CLAUDE_CODE_EFFORT_LEVEL=high

@REM Check and create ControlPlane dir path
if not exist "c:\src\controlplane" mkdir "c:\src\controlplane"
pushd "c:\src\controlplane"

ECHO === Claude starting ===
ECHO === (Ctrl+C to stop Claude only) ===

call claude --allow-dangerously-skip-permissions
ECHO Existed Claude.

popd