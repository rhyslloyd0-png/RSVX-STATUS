# Sets RSVX Status up on Windows Server so it starts with the machine and
# restarts itself if it ever stops.
#
#   Run in PowerShell as Administrator, from this folder:
#     powershell -ExecutionPolicy Bypass -File .\install.ps1
#     powershell -ExecutionPolicy Bypass -File .\install.ps1 -OpenFirewall   (also opens the page's port)

param([switch]$OpenFirewall)

$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Task = 'RSVX Status'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Run this in a PowerShell window opened as Administrator.'; exit 1 }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host 'Node.js is not installed. Install Node 18 or newer from nodejs.org, then run this again.'; exit 1 }
$major = [int](& $node -p 'process.versions.node.split(".")[0]')
if ($major -lt 18) { Write-Host "Node $major is too old. Node 18 or newer is needed."; exit 1 }

$envFile = Join-Path $Dir '.env'
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $Dir '.env.example') $envFile
  Write-Host "Created $envFile. Fill it in (it is opening in Notepad), save it, then run this again."
  Start-Process notepad.exe $envFile
  exit 0
}
New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'data') | Out-Null

$port = 8787
$line = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }

# A scheduled task that starts at boot, runs as SYSTEM and restarts on failure.
$action = New-ScheduledTaskAction -Execute $node -Argument 'server.js' -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false
}
Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'RSVX Status board' | Out-Null
Start-ScheduledTask -TaskName $Task
Start-Sleep -Seconds 3

if ($OpenFirewall) {
  if (-not (Get-NetFirewallRule -DisplayName 'RSVX Status' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'RSVX Status' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port | Out-Null
  }
  Write-Host "Firewall: port $port opened."
}

$state = (Get-ScheduledTask -TaskName $Task).State
Write-Host ""
Write-Host "RSVX Status task is $state, page on port $port."
Write-Host "Log:      Get-Content .\data\status.log -Tail 20"
Write-Host "Restart:  Stop-ScheduledTask 'RSVX Status'; Start-ScheduledTask 'RSVX Status'"
Write-Host "Update:   git pull, then restart as above"
$log = Join-Path $Dir 'data\status.log'
if (Test-Path $log) { Get-Content $log -Tail 5 }
