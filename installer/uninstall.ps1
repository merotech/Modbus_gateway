# Removes Modbus Gateway: startup task, firewall rule and program files.
# The configuration and log in ProgramData are kept unless -RemoveData is given.

param(
    [string]$InstallDir = "$env:ProgramFiles\ModbusGateway",
    [string]$DataDir = "$env:ProgramData\ModbusGateway",
    [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'
$TaskName = 'ModbusGateway'
$RuleName = 'Modbus Gateway'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -InstallDir `"$InstallDir`" -DataDir `"$DataDir`""
    if ($RemoveData) { $argList += ' -RemoveData' }
    Start-Process powershell -Verb RunAs -ArgumentList $argList
    exit
}

try {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed startup task '$TaskName'"
    }
    Get-Process -Name 'modbus-gateway' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1

    Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Write-Host 'Removed firewall rule'

    # This script may itself live in InstallDir; PowerShell has already read it, so deleting is safe.
    if (Test-Path $InstallDir) {
        Remove-Item $InstallDir -Recurse -Force
        Write-Host "Removed $InstallDir"
    }
    if ($RemoveData -and (Test-Path $DataDir)) {
        Remove-Item $DataDir -Recurse -Force
        Write-Host "Removed $DataDir"
    } elseif (Test-Path $DataDir) {
        Write-Host "Kept configuration in $DataDir (run with -RemoveData to delete it)"
    }
    Write-Host 'Uninstalled.' -ForegroundColor Green
} catch {
    Write-Host "Uninstall failed: $_" -ForegroundColor Red
}

Write-Host ''
Read-Host 'Press Enter to close'
