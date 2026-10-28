Modbus TCP Gateway for Windows
==============================

INSTALL (runs automatically at boot, restarts itself if it stops)
  Double-click install.cmd and accept the administrator prompt.
  The web UI opens when the install finishes, and the "Modbus Gateway"
  Start Menu / desktop shortcut opens it again later.
  From another PC: http://<this-pc-ip>:8080
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
  Double-click modbus-gateway.exe. It opens the web UI in your browser, runs in
  a console window and keeps config.json next to the exe. Close the window to
  stop it. If the gateway is already running it just opens the browser.

COMMAND LINE
  modbus-gateway.exe [--config <file>] [--log <file>] [--service] [--no-browser]
    --service     stay resident and restart the gateway if it exits
    --no-browser  do not open the web UI on start

NOTES
  Port 502 (Modbus) and 8080 (web) must be free. Change them in the web UI
  under Configuration; a web port change takes effect after a restart
  (Task Scheduler: right-click ModbusGateway > End, then Run; or reboot).
