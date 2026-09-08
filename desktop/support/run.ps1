# Asisto | Version: 5.00.053 | Fecha: 2026-09-08
param([Parameter(Mandatory=$true)][string]$Profile, [Parameter(Mandatory=$true)][string]$Node)
$ErrorActionPreference = 'Stop'
$profileId = Split-Path -Leaf $Profile
$mutex = [Threading.Mutex]::new($false, "Local\AsistoSupport-$profileId")
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
  while ($true) {
    $arguments = "`"$(Join-Path $PSScriptRoot 'agent.cjs')`" `"$Profile`""
    $worker = Start-Process -FilePath $Node -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    if ($worker.ExitCode -eq 2) { break }
    Start-Sleep -Seconds 10
  }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
