@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem API configuration is loaded from the ignored local config.json or the
rem in-app API settings screen. Never hard-code secrets in this script.
set "PATH=%PATH%;C:\Program Files\nodejs;C:\Users\%USERNAME%\AppData\Roaming\npm"

pnpm dev:electron
pause
