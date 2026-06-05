# LEGO Monitor - Windows Task Scheduler 安裝腳本
# 用法：在 PowerShell 以「系統管理員身份執行」，貼上此腳本路徑執行
# 例：powershell -ExecutionPolicy Bypass -File "C:\Users\zzasq\OneDrive\Documents\coupang-lego-monitor\setup-task-scheduler.ps1"

$batPath  = 'C:\Users\zzasq\OneDrive\Documents\coupang-lego-monitor\run-scan.bat'
$logPath  = 'C:\Users\zzasq\OneDrive\Documents\coupang-lego-monitor\logs\task-scheduler.log'

$action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$batPath`" >> `"$logPath`" 2>&1"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -StartWhenAvailable $true

# 早上 10:10，週一至週五
$trigger1 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At '10:10AM'
Register-ScheduledTask -TaskName 'LEGO Price Monitor - 10:10' `
    -Action $action -Trigger $trigger1 -Settings $settings `
    -RunLevel Highest -Force
Write-Host "✅ 已建立排程：週一至週五 10:10"

# 下午 16:50，週一至週五
$trigger2 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At '4:50PM'
Register-ScheduledTask -TaskName 'LEGO Price Monitor - 16:50' `
    -Action $action -Trigger $trigger2 -Settings $settings `
    -RunLevel Highest -Force
Write-Host "✅ 已建立排程：週一至週五 16:50"

Write-Host ""
Write-Host "完成！可至「工作排程器」查看 LEGO Price Monitor 兩個任務。"
