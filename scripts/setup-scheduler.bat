@echo off
:: Coupang LEGO Monitor - Windows Task Scheduler Setup
:: Run this file as Administrator. Creates one daily task at 11:35.

set RUN_BAT=%~dp0run.bat

schtasks /create /tn "LegoMonitor-Morning" /tr "\"%RUN_BAT%\"" /sc daily /st 11:35 /rl highest /f
if %ERRORLEVEL% equ 0 (
  echo [OK] LegoMonitor-Morning 11:35 daily.
) else (
  echo [FAIL] Please run as Administrator.
)

schtasks /query /tn "LegoMonitor-Morning"
pause
