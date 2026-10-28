Modbus TCP Gateway for Windows
==============================

INSTALL (runs automatically at boot, restarts itself if it stops)
  Double-click install.cmd and accept the administrator prompt.
  Then open http://localhost:8080 (from another PC: http://<this-pc-ip>:8080).
  Configuration password: hotelo

  Program:        C:\Program Files\ModbusGateway\modbus-gateway.exe
  Configuration:  C:\ProgramData\ModbusGateway\config.json
  Log:            C:\ProgramData\ModbusGateway\gateway.log
  Startup task:   "ModbusGateway" in Task Scheduler (runs as SYSTEM)
  Firewall:       inbound rule "Modbus Gateway" for the program

  Running install.cmd again upgrades the program and keeps the configuration.

UNINSTALL
  Double-click uninstall.cmd. The configuration is kept; to delete it too run:
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -RemoveData

PORTABLE (no install)
  Double-click modbus-gateway.exe. It runs in a console window and keeps
  config.json next to the exe. Close the window to stop it.

COMMAND LINE
  modbus-gateway.exe [--config <file>] [--log <file>] [--service]
    --service  stay resident and restart the gateway if it exits

NOTES
  Port 502 (Modbus) and 8080 (web) must be free. Change them in the web UI
  under Configuration; a web port change takes effect after a restart
  (Task Scheduler: right-click ModbusGateway > End, then Run; or reboot).
