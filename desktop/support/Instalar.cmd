@echo off
rem Asisto | Version: 5.00.269 | Fecha: 2026-09-29
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Instalar.ps1"
set "ASISTO_EXIT=%ERRORLEVEL%"
echo.
if not "%ASISTO_EXIT%"=="0" (
  echo LA INSTALACION NO SE COMPLETO. Revisa el error de arriba.
) else (
  echo INSTALACION COMPLETADA. El navegador quedo abierto para autorizar esta PC.
)
echo Esta ventana permanecera abierta para que puedas leer el resultado.
pause
exit /b %ASISTO_EXIT%
