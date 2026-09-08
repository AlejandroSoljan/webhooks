# Asisto | Version: 5.00.055 | Fecha: 2026-09-08
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'AsistoSupport'
$release = Join-Path $root 'app-5.00.055'
$arch = if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
$runtime = Join-Path $root "node-v24.12.0-win-$arch"
$node = Join-Path $runtime 'node.exe'
New-Item -ItemType Directory -Path $root -Force | Out-Null
Write-Host 'Preparando Asisto en esta PC...'
if (-not (Test-Path -LiteralPath $node)) {
  $zip = Join-Path $root "node-v24.12.0-win-$arch.zip"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v24.12.0/node-v24.12.0-win-$arch.zip" -OutFile $zip
  $expected = if ($arch -eq 'arm64') { 'b05e7e066f813d35ad3cd9c24eedaee074c012ac7e00071297608fdd2e948ae3' } else { '9c125f61ae947b52e779095830f9cac267846a043ef7192183c84016aaad2812' }
  if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'El runtime descargado no paso la verificacion.' }
  Expand-Archive -LiteralPath $zip -DestinationPath $root -Force
  Remove-Item -LiteralPath $zip
}
New-Item -ItemType Directory -Path $release -Force | Out-Null
foreach ($name in @('agent.cjs','storage.cjs','protect.ps1','run.ps1','startup.ps1','package.json','package-lock.json')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $release $name) -Force
}
$env:PATH = "$runtime;$env:PATH"
Push-Location $release
try {
  & $node (Join-Path $runtime 'node_modules/npm/bin/npm-cli.js') ci --omit=dev --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'No se pudieron instalar los componentes de WhatsApp.' }
} finally { Pop-Location }
$existing = @(Get-ChildItem -LiteralPath (Join-Path $root 'profiles') -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^[a-fA-F0-9-]{36}$' })
if ($existing.Count -gt 1) { throw 'Hay varios perfiles instalados. Actualiza el perfil correspondiente antes de continuar.' }
$profileId = if ($existing.Count -eq 1) { $existing[0].Name } else { [Guid]::NewGuid().ToString() }
$profile = Join-Path (Join-Path $root 'profiles') $profileId
New-Item -ItemType Directory -Path $profile -Force | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $profile '/inheritance:r' '/grant:r' "*$($sid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'No se pudo proteger el perfil local.' }
$runScript = Join-Path $release 'run.ps1'
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runScript`" -Profile `"$profile`" -Node `"$node`""
& (Join-Path $release 'startup.ps1') -Profile $profile -Node $node
# Only replace processes for this exact, preserved profile, after registration succeeds.
$owned = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -in @('powershell.exe','node.exe') -and $_.CommandLine -and
  $_.CommandLine.Contains('"' + $profile + '"') -and $_.CommandLine.Contains($root + '\') -and
  ($_.CommandLine.Contains('\run.ps1"') -or $_.CommandLine.Contains('\agent.cjs"'))
})
foreach ($proc in ($owned | Sort-Object @{Expression={if ($_.Name -eq 'powershell.exe') {0} else {1}}})) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-ScheduledTask -TaskName "AsistoSupport-$profileId"
Write-Host 'Instalado. Se abrira Asisto para autorizar esta PC con tu usuario.'
Write-Host 'Luego el agente iniciara automaticamente al ingresar a Windows.'
Write-Host "Perfil instalado: $profile"
