@echo off
rem Double-click to install. install.ps1 asks for administrator rights itself.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
