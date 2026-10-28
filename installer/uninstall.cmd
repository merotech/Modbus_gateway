@echo off
rem Double-click to uninstall. Configuration in C:\ProgramData\ModbusGateway is kept.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
