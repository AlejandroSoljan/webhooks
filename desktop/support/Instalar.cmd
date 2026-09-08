@echo off
rem Asisto | Version: 5.00.059 | Fecha: 2026-09-08
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Instalar.ps1"
if errorlevel 1 pause
