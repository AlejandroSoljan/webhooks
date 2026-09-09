# Asisto | Version: 5.00.079 | Fecha: 2026-09-09
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'extensions/whatsapp-support'
$destination = Join-Path $repo 'static/downloads/AsistoChrome-1.0.5.zip'
Compress-Archive -Path (Join-Path $source '*') -DestinationPath $destination -Force
