@echo off
rem Double-click to start the Arcade Player. Add --kiosk for a full-screen cabinet.
cd /d "%~dp0"
if not exist node_modules\electron (
  echo First run: installing Electron...
  call npm install
)
call npx electron . %*
