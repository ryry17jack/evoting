<#
  setup-node.ps1 - download a "portable" Node.js into a subfolder.
  Used by start-agent.bat and package-agent.bat.
  Requires no Administrator rights and does not touch the system Node.js.
  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
  unless it has a UTF-8 BOM, so non-ASCII text would break parsing.
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,   # e.g. 22.18.0
  [Parameter(Mandatory = $true)][string]$Dest       # target dir, e.g. <agent>\node
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # disable progress bar -> faster download
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

if (Test-Path (Join-Path $Dest 'node.exe')) {
  Write-Host "[i] Portable Node.js already present at $Dest"
  exit 0
}

# Pick architecture to match this machine
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$dist = "node-v$Version-win-$arch"
$url  = "https://nodejs.org/dist/v$Version/$dist.zip"
$zip  = Join-Path $env:TEMP "$dist.zip"
$work = Join-Path $env:TEMP "evoting-node-$Version"

Write-Host "[i] Downloading Node.js: $url"
Invoke-WebRequest -Uri $url -OutFile $zip

if (Test-Path $work) { Remove-Item $work -Recurse -Force }
Write-Host "[i] Extracting..."
Expand-Archive -Path $zip -DestinationPath $work -Force

$src = Join-Path $work $dist
if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
Move-Item -Path $src -Destination $Dest

Remove-Item $zip  -Force            -ErrorAction SilentlyContinue
Remove-Item $work -Recurse -Force   -ErrorAction SilentlyContinue

Write-Host "[OK] Portable Node.js $Version ($arch) installed at $Dest"
