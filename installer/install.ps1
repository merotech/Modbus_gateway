# Installs Modbus Gateway to start automatically with Windows.
#   - program:  C:\Program Files\ModbusGateway\modbus-gateway.exe
#   - data:     C:\ProgramData\ModbusGateway\config.json and gateway.log
#   - startup:  scheduled task "ModbusGateway" running as SYSTEM at boot, before any logon
#   - firewall: inbound allow rule for the program (covers the slave and web ports, whatever they are)
# Re-running upgrades the program in place and keeps the existing configuration.

param(
    [string]$InstallDir = "$env:ProgramFiles\ModbusGateway",
    [string]$DataDir = "$env:ProgramData\ModbusGateway"
)

$ErrorActionPreference = 'Stop'
$TaskName = 'ModbusGateway'
$RuleName = 'Modbus Gateway'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Write-Host 'Requesting administrator rights...'
    $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -InstallDir `"$InstallDir`" -DataDir `"$DataDir`""
    Start-Process powershell -Verb RunAs -ArgumentList $argList
    exit
}

try {
    $source = Join-Path $PSScriptRoot 'modbus-gateway.exe'
    if (-not (Test-Path $source)) { throw "modbus-gateway.exe not found next to install.ps1 ($PSScriptRoot)" }

    Write-Host 'Stopping any running instance...'
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    Get-Process -Name 'modbus-gateway' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1

    Write-Host "Copying program to $InstallDir"
    New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir | Out-Null
    Copy-Item $source $InstallDir -Force
    Copy-Item (Join-Path $PSScriptRoot 'uninstall.ps1') $InstallDir -Force

    $exe = Join-Path $InstallDir 'modbus-gateway.exe'
    $config = Join-Path $DataDir 'config.json'
    $log = Join-Path $DataDir 'gateway.log'

    Write-Host "Registering startup task '$TaskName'"
    $action = New-ScheduledTaskAction -Execute $exe -Argument "--service --config `"$config`" --log `"$log`"" -WorkingDirectory $DataDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'Modbus TCP gateway (local slave + N masters). Web UI on port 8080 by default.' -Force | Out-Null

    Write-Host 'Adding firewall rule'
    Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Program $exe -Action Allow -Profile Any | Out-Null

    # The shortcut runs the exe, which sees the installed gateway already answering and only
    # opens the browser on it, so it is safe to click any time.
    Write-Host 'Adding Start Menu and desktop shortcuts'
    $shell = New-Object -ComObject WScript.Shell
    foreach ($dir in "$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:PUBLIC\Desktop") {
        $lnk = $shell.CreateShortcut((Join-Path $dir 'Modbus Gateway.lnk'))
        $lnk.TargetPath = $exe
        $lnk.Arguments = "--config `"$config`" --log `"$log`""
        $lnk.WorkingDirectory = $DataDir
        $lnk.WindowStyle = 7
        $lnk.Description = 'Open the Modbus Gateway web UI'
        $lnk.Save()
    }

    Write-Host 'Starting gateway'
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3

    $webPort = 8080
    if (Test-Path $config) {
        try { $webPort = (Get-Content $config -Raw | ConvertFrom-Json).web.port } catch {}
    }
    $running = Get-Process -Name 'modbus-gateway' -ErrorAction SilentlyContinue
    Write-Host ''
    if ($running) {
        Write-Host "Installed and running. Web UI: http://localhost:$webPort  (configuration password: hotelo)" -ForegroundColor Green
        Start-Process "http://localhost:$webPort"
    } else {
        Write-Host "Installed, but the gateway is not running. Check $log" -ForegroundColor Yellow
    }
    Write-Host "Configuration: $config"
    Write-Host "Log:           $log"
} catch {
    Write-Host "Install failed: $_" -ForegroundColor Red
}

Write-Host ''
Read-Host 'Press Enter to close'
