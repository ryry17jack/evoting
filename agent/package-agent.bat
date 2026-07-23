@echo off
REM =====================================================================
REM  package-agent.bat - build a self-contained package (agent-dist)
REM
REM  Run this ONCE on a machine that has Node.js + C++ Build Tools
REM  (e.g. the developer PC). It produces an "agent-dist" folder that is
REM  fully ready to use:
REM    - card-agent.js + the compiled card library (node_modules)
REM    - a portable Node.js
REM    - start-agent.bat
REM  Copy the agent-dist folder to any kiosk PC and double-click
REM  start-agent.bat - no internet, no install, no compiler needed.
REM
REM  (Thai guide: see README.md)
REM  NOTE: keep this file ASCII-only (cmd.exe cannot reliably parse UTF-8).
REM =====================================================================
setlocal
title Package E-Voting Card Agent
cd /d "%~dp0"

set "NODE_VER=22.18.0"
set "DIST=%~dp0..\agent-dist"

echo ============================================================
echo   Building self-contained package (agent-dist)
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Install Node.js on this machine first: https://nodejs.org
  pause
  exit /b 1
)

echo [1/4] Installing + compiling the card library (npm install)...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed - this machine needs Visual Studio Build Tools ^(C++^) + Python
  pause
  exit /b 1
)

echo [2/4] Preparing portable Node.js...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-node.ps1" -Version "%NODE_VER%" -Dest "%~dp0node"
if errorlevel 1 (
  echo [ERROR] Failed to download portable Node.js
  pause
  exit /b 1
)

echo [3/4] Copying files into agent-dist and trimming build junk...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$d='%DIST%';" ^
  "if(Test-Path $d){Remove-Item $d -Recurse -Force};" ^
  "New-Item -ItemType Directory -Path $d | Out-Null;" ^
  "foreach($i in 'card-agent.js','package.json','README.md','start-agent.bat','setup-node.ps1','node_modules','node'){ Copy-Item -Path (Join-Path '%~dp0' $i) -Destination $d -Recurse -Force };" ^
  "$rel=Join-Path $d 'node_modules\@pokusew\pcsclite\build\Release';" ^
  "if(Test-Path (Join-Path $rel 'obj')){Remove-Item (Join-Path $rel 'obj') -Recurse -Force};" ^
  "Get-ChildItem $rel -Include *.iobj,*.ipdb,*.pdb -File -Recurse -EA SilentlyContinue | Remove-Item -Force -EA SilentlyContinue;" ^
  "Write-Host '[OK] copied'"
if errorlevel 1 (
  echo [ERROR] Copy step failed
  pause
  exit /b 1
)

echo [4/4] Done.
echo.
echo ============================================================
echo   Ready-made package is at:
echo     %DIST%
echo.
echo   Copy the agent-dist folder to a kiosk PC and double-click
echo   start-agent.bat inside it (no internet needed).
echo ============================================================
pause
