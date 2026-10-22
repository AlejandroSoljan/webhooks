# Asisto | Version: 5.00.149 | Fecha: 2026-09-23
param([Parameter(Mandatory=$true)][string]$Profile, [Parameter(Mandatory=$true)][string]$Node)
$ErrorActionPreference = 'Stop'
$profileId = Split-Path -Leaf $Profile
$mutex = [Threading.Mutex]::new($false, "Local\AsistoSupport-$profileId")
try { $acquired = $mutex.WaitOne(0) }
catch [Threading.AbandonedMutexException] { $acquired = $true }
if (-not $acquired) { $mutex.Dispose(); exit 0 }
try {
  # A Task Scheduler restart can leave its Node child alive. Only reclaim the
  # worker for this exact executable/profile after acquiring the profile mutex.
  $agentScript = Join-Path $PSScriptRoot 'agent.cjs'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.ExecutablePath -eq $Node -and $_.CommandLine -and
    $_.CommandLine.Contains('"' + $agentScript + '"') -and
    $_.CommandLine.Contains('"' + $Profile + '"')
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }
  while ($true) {
    $logs = Join-Path $Profile 'logs'
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $stdout = Join-Path $logs 'agent-output.log'
    $stderr = Join-Path $logs 'agent-error.log'
    $arguments = "`"$(Join-Path $PSScriptRoot 'agent.cjs')`" `"$Profile`""
    $worker = Start-Process -FilePath $Node -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if ($worker.ExitCode -eq 2) { break }
    Start-Sleep -Seconds 10
  }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
