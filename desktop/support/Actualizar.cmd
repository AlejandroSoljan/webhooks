@echo off
rem Asisto | Version: 5.00.306 | Fecha: 2026-10-22
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Actualizar.ps1"
set "ASISTO_UPDATE_EXIT=%ERRORLEVEL%"
echo.
if not "%ASISTO_UPDATE_EXIT%"=="0" echo No se completo la actualizacion. Conserva esta ventana para revisar el error.
pause
exit /b %ASISTO_UPDATE_EXIT%
