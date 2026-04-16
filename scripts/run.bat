@echo off
:: Coupang LEGO Monitor - Run script
:: Called by Windows Task Scheduler

cd /d "%~dp0.."
"C:\Program Files\nodejs\node.exe" src\index.js >> logs\run.log 2>&1
