# Asisto | Version: 5.00.274 | Fecha: 2026-10-01
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'extensions/whatsapp-support'
$destination = Join-Path $repo 'static/downloads/AsistoChrome-1.0.48.zip'
Compress-Archive -Path (Join-Path $source '*') -DestinationPath $destination -Force
