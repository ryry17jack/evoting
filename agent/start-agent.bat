@echo off
REM =====================================================================
REM  E-Voting Local Card Agent - one-click launcher
REM  Double-click on the kiosk PC that has the USB card reader plugged in.
REM
REM  - Finds a compatible Node.js by itself; if none/wrong version, it
REM    downloads a portable Node.js automatically (no Administrator needed).
REM  - If a pre-compiled node_modules is shipped alongside, it runs at once.
REM
REM  (Thai setup guide: see README.md)
REM  NOTE: keep this file ASCII-only. cmd.exe cannot reliably parse a UTF-8
REM  batch file, so all messages here are in English on purpose.
REM =====================================================================
setlocal enabledelayedexpansion
title E-Voting Card Agent
cd /d "%~dp0"

REM Node version matching the pre-compiled card library (ABI 127 = Node 22)
set "NODE_VER=22.18.0"
set "NEED_ABI=127"

echo ============================================================
echo   E-Voting Local Card Agent
echo ============================================================
echo.

REM ---- 1) Find a usable Node.js (ABI must match the card library) ----
set "NODE_EXE="

REM 1a) Portable Node.js in this folder (already downloaded / shipped)
if exist "%~dp0node\node.exe" (
  set "NODE_EXE=%~dp0node\node.exe"
  set "PATH=%~dp0node;%PATH%"
  goto have_node
)

REM 1b) System Node.js - only usable when its ABI matches
where node >nul 2>nul
if not errorlevel 1 (
  set "SYS_ABI="
  for /f "delims=" %%v in ('node -p "process.versions.modules" 2^>nul') do set "SYS_ABI=%%v"
  if "!SYS_ABI!"=="%NEED_ABI%" (
    set "NODE_EXE=node"
    goto have_node
  ) else (
    echo [i] Found system Node.js but its ABI ^(!SYS_ABI!^) does not match the
    echo     card library ^(needs %NEED_ABI%^). Using a portable Node.js instead.
    echo.
  )
)

REM 1c) Download a portable Node.js (first run only, needs internet)
echo [i] Preparing portable Node.js %NODE_VER% ... ^(internet required the first time^)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-node.ps1" -Version "%NODE_VER%" -Dest "%~dp0node"
if errorlevel 1 (
  echo.
  echo [ERROR] Could not prepare Node.js. Check your internet connection and retry,
  echo         or ask the admin for the ready-made package folder ^(agent-dist^).
  pause
  exit /b 1
)
set "NODE_EXE=%~dp0node\node.exe"
set "PATH=%~dp0node;%PATH%"

:have_node
for /f "delims=" %%v in ('"%NODE_EXE%" -v') do set "NODE_SHOW=%%v"
echo [OK] Using Node.js !NODE_SHOW!
echo.

REM ---- 2) Ensure the card library exists (should ship pre-compiled) ----
if not exist "%~dp0node_modules\@pokusew\pcsclite\build\Release\pcsclite.node" (
  echo [i] Pre-compiled card library not found - installing ^(may need Build Tools^)...
  if exist "%~dp0node\npm.cmd" ( set "NPM=%~dp0node\npm.cmd" ) else ( set "NPM=npm" )
  call "!NPM!" install
  if errorlevel 1 (
    echo.
    echo [ERROR] Failed to install the card library ^(native module compile failed^).
    echo         Easiest fix: get the ready-made package folder ^(agent-dist^) that
    echo         is already compiled, then double-click start-agent.bat inside it.
    pause
    exit /b 1
  )
)

REM ---- 3) Start the agent ----
echo [OK] Ready - starting Card Agent...
echo     Keep this window open during voting.
echo     When voting is finished, press  ESC  to close this program.
echo     (Thai instructions are shown by the agent window below.)
echo.
REM Switch console to UTF-8 so the agent's Thai messages render correctly.
REM Safe here because this .bat is ASCII-only; only Node's UTF-8 output follows.
chcp 65001 >nul
"%NODE_EXE%" "%~dp0card-agent.js"

REM Clean exit via ESC returns 0 -> just close. An error keeps the window open.
if errorlevel 1 (
  echo.
  echo Agent stopped with an error. See messages above.
  pause
)
