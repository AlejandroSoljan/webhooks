# Asisto | Version: 5.00.227 | Fecha: 2026-09-25
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'desktop/support'
$extension = Join-Path $repo 'extensions/whatsapp-support'
$destination = Join-Path $repo 'static/downloads'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$stage = Join-Path ([IO.Path]::GetTempPath()) ('AsistoTareas-' + [Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  foreach ($name in @('Instalar.cmd','Instalar.ps1','run.ps1','startup.ps1','agent.cjs','local.cjs','storage.cjs','protect.ps1','package.json','package-lock.json','LEEME.txt')) {
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $stage $name) -Force
  }
  $extensionStage = Join-Path $stage 'Extension'
  New-Item -ItemType Directory -Path $extensionStage -Force | Out-Null
  Copy-Item -Path (Join-Path $extension '*') -Destination $extensionStage -Recurse -Force
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath (Join-Path $destination 'AsistoTareas-5.00.227.zip') -Force
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
