@echo off
:: Coupang LEGO Monitor - Windows Task Scheduler Setup
:: Run this file as Administrator

set PROJECT_DIR=%~dp0..
set RUN_BAT=%~dp0run.bat

echo === Coupang LEGO Monitor - Scheduler Setup ===
echo Project : %PROJECT_DIR%
echo Script  : %RUN_BAT%
echo.

:: Remove old tasks if exist
schtasks /delete /tn "LegoMonitor-Morning" /f >nul 2>&1
schtasks /delete /tn "LegoMonitor-Afternoon" /f >nul 2>&1

:: Create morning task at 10:10
schtasks /create /tn "LegoMonitor-Morning" /tr "\"%RUN_BAT%\"" /sc daily /st 10:10 /rl highest /f
if %ERRORLEVEL% equ 0 (
  echo [OK] Morning 10:10 task created.
) else (
  echo [FAIL] Morning task failed. Please run as Administrator.
)

:: Create afternoon task at 16:50
schtasks /create /tn "LegoMonitor-Afternoon" /tr "\"%RUN_BAT%\"" /sc daily /st 16:50 /rl highest /f
if %ERRORLEVEL% equ 0 (
  echo [OK] Afternoon 16:50 task created.
) else (
  echo [FAIL] Afternoon task failed. Please run as Administrator.
)

echo.
echo === Verify tasks ===
schtasks /query /tn "LegoMonitor-Morning"
schtasks /query /tn "LegoMonitor-Afternoon"

echo.
echo Done. Check Task Scheduler to confirm both tasks appear.
echo To run manually: schtasks /run /tn "LegoMonitor-Morning"
pause
