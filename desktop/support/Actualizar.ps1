# Asisto | Version: 5.00.306 | Fecha: 2026-10-22
# Update existing worker code only. Never run pairing, npm, logout or storage writes.
$ErrorActionPreference = 'Stop'
$agentRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'AsistoSupport'))
$profilesDirectory = Join-Path $agentRoot 'profiles'
$profiles = @(Get-ChildItem -LiteralPath $profilesDirectory -Directory -ErrorAction Stop | Where-Object { $_.Name -match '^[a-fA-F0-9-]{36}$' })
if (-not $profiles.Count) { throw 'No hay un agente instalado para este usuario de Windows. No se creo ningun perfil.' }
$files = @('agent.cjs','media-stream-patch.cjs','run.ps1')
foreach ($name in $files) { if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $name))) { throw "Falta $name. Extrae el ZIP completo antes de actualizar." } }
foreach ($profile in $profiles) {
  $taskName = 'AsistoSupport-' + $profile.Name
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $actions = @($task.Actions)
  if ($actions.Count -ne 1) { throw "Accion inesperada: $taskName" }
  $match = [regex]::Match($actions[0].Arguments, '-File\s+"(?<run>[^"]+)"\s+-Profile\s+"(?<profile>[^"]+)"\s+-Node\s+"(?<node>[^"]+)"')
  if (-not $match.Success) { throw "Configuracion de inicio inesperada: $taskName" }
  $run = [IO.Path]::GetFullPath($match.Groups['run'].Value)
  $expectedProfile = [IO.Path]::GetFullPath($match.Groups['profile'].Value)
  if (-not $run.StartsWith($agentRoot + '\',[StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($run) -ne 'run.ps1' -or $expectedProfile -ne $profile.FullName) { throw 'El destino no corresponde al perfil de este usuario.' }
  $release = Split-Path -Parent $run
  $backupDirectory = Join-Path $agentRoot 'repair-backups'
  New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
  $backup = Join-Path $backupDirectory ('worker-' + $profile.Name + '-' + [Guid]::NewGuid().ToString('N') + '.zip')
  $existing = @($files | ForEach-Object { Join-Path $release $_ } | Where-Object { Test-Path -LiteralPath $_ })
  Compress-Archive -LiteralPath $existing -DestinationPath $backup
  $started = Get-Date
  foreach ($name in $files) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $release $name) -Force }
  Stop-ScheduledTask -TaskName $taskName
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') {
    if ((Get-Date) -ge $deadline) { throw 'El supervisor anterior sigue deteniendose. Reintenta Actualizar.cmd.' }
    Start-Sleep -Milliseconds 250
  }
  Start-ScheduledTask -TaskName $taskName
  $statusFile = Join-Path $profile.FullName 'status.json'
  $deadline = (Get-Date).AddSeconds(60)
  $startedOK = $false
  do {
    Start-Sleep -Seconds 1
    try {
      $status = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
      if ([datetime]$status.updatedAt -ge $started.ToUniversalTime() -and $status.state -eq 'active') { $startedOK = $true; break }
      if ([datetime]$status.updatedAt -ge $started.ToUniversalTime() -and $status.state -in @('access_revoked','number_mismatch','awaiting_approval')) { break }
    } catch { }
  } while ((Get-Date) -lt $deadline)
  if (-not $startedOK) { throw 'Los archivos se actualizaron, pero falta confirmar el latido del agente. No borres el perfil ni desvincules WhatsApp. Revisa logs en el perfil.' }
  Write-Host "Agente actualizado: $taskName. Perfil y cola conservados. Respaldo: $backup"
}
