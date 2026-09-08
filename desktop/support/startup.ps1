# Asisto | Version: 5.00.056 | Fecha: 2026-09-08
param([Parameter(Mandatory=$true)][string]$Profile, [Parameter(Mandatory=$true)][string]$Node)
$ErrorActionPreference = 'Stop'
$profileId = Split-Path -Leaf $Profile
if ($profileId -notmatch '^[a-fA-F0-9-]{36}$') { throw 'Perfil no valido.' }
$taskName = "AsistoSupport-$profileId"
$runScript = Join-Path $PSScriptRoot 'run.ps1'
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runScript`" -Profile `"$Profile`" -Node `"$Node`""
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Agente personal de Asisto. Inicia al ingresar a Windows y conserva la sesion de WhatsApp de este usuario.' -Force | Out-Null
# Remove the previous startup entry only after the scheduled task exists.
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (Get-ItemProperty -Path $runKey -Name $taskName -ErrorAction SilentlyContinue) {
  Remove-ItemProperty -Path $runKey -Name $taskName
}
Write-Host "Inicio automatico configurado: $taskName"
