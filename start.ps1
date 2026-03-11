param(
  [switch]$NoPause
)
$ErrorActionPreference = "Stop"

function Pause-IfNeeded {
  param([string]$Message = "Press Enter to close")
  if (-not $NoPause) { Read-Host $Message | Out-Null }
}

function Tail-Log {
  param([string]$Path, [int]$Lines = 60)
  if (Test-Path $Path) {
    Write-Host "---- server.log (last $Lines lines) ----" -ForegroundColor Yellow
    Get-Content $Path -Tail $Lines
    Write-Host "---- end ----" -ForegroundColor Yellow
  }
}

try {
  $root = Split-Path -Parent $PSCommandPath
  $backend = Join-Path $root "backend-node"
  $frontend = Join-Path $root "frontend"
  $staticDir = Join-Path $frontend "dist"
  $log = Join-Path $backend "server.log"

  Write-Host "=== 115 Transfer Tool Launcher ==="
  Write-Host "Root: $root"

  # Stop any process listening on port 8000 (previous server)
  try {
    $pids = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($pid in $pids) {
      Write-Host "Stopping process on port 8000 PID=$pid"
      Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
  } catch {}

  # Also stop node processes running dist/server.js just in case
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*dist*server.js*" } |
    ForEach-Object {
      Write-Host "Stopping previous node PID=$($_.ProcessId)"
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

  Start-Sleep -Milliseconds 800

  if (Test-Path $frontend) {
    Set-Location $frontend
    if (-not (Test-Path "node_modules")) {
      Write-Host "Installing frontend dependencies..."
      npm install --silent
    }
    Write-Host "Building frontend..."
    npm run build --silent
  }

  Set-Location $backend

  if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..."
    npm install --silent
  }

  Write-Host "Building TypeScript..."
  npm run build --silent

  Write-Host "Starting server (http://localhost:8000)..."
  if (Test-Path $log) {
    try { Remove-Item $log -Force -ErrorAction Stop }
    catch { Write-Host "server.log is locked, appending instead." -ForegroundColor Yellow }
  }

  $cmdArgs = "/c set ""STATIC_DIR=$staticDir"" && node dist/server.js >> server.log 2>&1"
  Start-Process -FilePath "cmd.exe" -ArgumentList $cmdArgs -WorkingDirectory $backend -WindowStyle Hidden
  Start-Sleep -Seconds 1

  Start-Process "http://localhost:8000"

  Write-Host "Server log: $log"
  Pause-IfNeeded "Press Enter to close..."
}
catch {
  Write-Error $_
  Tail-Log -Path $log
  Pause-IfNeeded "Press Enter to close..."
}
