# Asisto | Version: 5.00.058 | Fecha: 2026-09-08
param([Parameter(Mandatory=$true)][string]$Profile)
$ErrorActionPreference = 'Stop'
try {
  $status = Get-Content -LiteralPath (Join-Path $Profile 'status.json') -Raw | ConvertFrom-Json
  $url = 'https://asistobot.com.ar/admin/wweb'
  if ($status.state -eq 'awaiting_approval') {
    $candidate = [string]$status.verificationUrl
    if ($candidate -match '^https://asistobot\.com\.ar/(admin/wweb|ui/support)\?device=[A-F0-9]{12}$' -and
        ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($status.updatedAt)).TotalMinutes -lt 10) {
      $url = $candidate
    } else { throw 'El enlace vencio. Espera a que el agente lo renueve y vuelve a abrir este acceso.' }
  }
  Start-Process -FilePath $url
} catch {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show('No se pudo abrir la vinculacion. Comprueba que el agente de Asisto este iniciado y conectado; luego vuelve a intentar.', 'Asisto') | Out-Null
}
