@echo off
title Ford Energy PGS v10 Local Preview
cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 (
  echo Python launcher was not found.
  echo Install Python or run this project through another local web server.
  pause
  exit /b 1
)

echo Starting PGS v10 at http://127.0.0.1:8765/
echo Keep this window open while testing. Press Ctrl+C to stop.

rem Stop only a stale Python preview server already using the PGS port.
powershell -NoProfile -Command "$listeners=Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue; foreach($listener in $listeners){$process=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess); if($process.Name -match '^python(\.exe)?$' -and $process.CommandLine -match 'http\.server\s+8765'){Stop-Process -Id $process.ProcessId -Force}}"

start "" "http://127.0.0.1:8765/?build=10.5.0"
py -m http.server 8765 --bind 127.0.0.1
