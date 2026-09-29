# Asisto | Version: 5.00.265 | Fecha: 2026-09-29
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'extensions/whatsapp-support'
$destination = Join-Path $repo 'static/downloads/AsistoChrome-1.0.43.zip'
Compress-Archive -Path (Join-Path $source '*') -DestinationPath $destination -Force
