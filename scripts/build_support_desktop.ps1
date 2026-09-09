# Asisto | Version: 5.00.072 | Fecha: 2026-09-09
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'desktop/support'
$destination = Join-Path $repo 'static/downloads'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$files = @('Instalar.cmd','Instalar.ps1','run.ps1','startup.ps1','agent.cjs','local.cjs','storage.cjs','protect.ps1','package.json','package-lock.json','LEEME.txt') | ForEach-Object { Join-Path $source $_ }
Compress-Archive -LiteralPath $files -DestinationPath (Join-Path $destination 'AsistoSupport-5.00.072.zip') -Force
