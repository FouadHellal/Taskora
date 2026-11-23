# Taskora Omada agent - Windows installer
#
# Run in PowerShell *as Administrator* on the machine of the Omada controller (or any machine
# of the same network). Taskora shows the exact command on its Omada page, e.g.:
#
#   & ([scriptblock]::Create((irm https://taskora.example.com/api/v1/integrations/omada/agent/files/install-windows.ps1))) -TaskoraUrl https://taskora.example.com -Token tki_xxx
#
# It installs Node.js (portable, only if missing), the agent and its configuration in
# C:\ProgramData\TaskoraOmadaAgent, tests the connections, and registers a scheduled task that
# starts the agent at boot (as SYSTEM) and restarts it if it stops. Run it again to update.
# Uninstall: add -Uninstall.
param(
  [string]$TaskoraUrl,
  [string]$Token,
  [string]$ClientId,
  [string]$ClientSecret,
  [string]$OmadaUrl = '',
  [string]$OmadaId = '',
  [switch]$VerifyTls,
  [switch]$Uninstall,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Dir = Join-Path $env:ProgramData 'TaskoraOmadaAgent'
$TaskName = 'Taskora Omada Agent'

function Say([string]$m, [string]$c = 'Cyan') { Write-Host $m -ForegroundColor $c }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run PowerShell as Administrator (right-click PowerShell > Run as administrator), then run the command again.'
}

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*omada-agent.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  if (Test-Path $Dir) { Remove-Item $Dir -Recurse -Force }
  Say 'Taskora Omada agent removed.' 'Green'
  return
}

if (-not $TaskoraUrl) { $TaskoraUrl = Read-Host 'Taskora address (e.g. https://taskora.example.com)' }
$TaskoraUrl = $TaskoraUrl.TrimEnd('/')
$existing = $null
$cfgPath = Join-Path $Dir 'config.json'
if (Test-Path $cfgPath) { try { $existing = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch { $existing = $null } }
if (-not $Token) { if ($existing -and $existing.token) { $Token = $existing.token } else { $Token = Read-Host 'Agent token from Taskora (tki_...)' } }
if (-not $ClientId) { if ($existing -and $existing.omadaClientId) { $ClientId = $existing.omadaClientId } else { $ClientId = Read-Host 'Omada Open API Client ID' } }
if (-not $ClientSecret) {
  if ($existing -and $existing.omadaClientSecret) { $ClientSecret = $existing.omadaClientSecret }
  else {
    $sec = Read-Host 'Omada Open API Client Secret' -AsSecureString
    $ClientSecret = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
}
if (-not $OmadaUrl -and $existing -and $existing.omadaUrl) { $OmadaUrl = $existing.omadaUrl }
if (-not $OmadaId -and $existing -and $existing.omadacId) { $OmadaId = $existing.omadacId }

New-Item -ItemType Directory -Force -Path $Dir | Out-Null

# 1. Node.js: use the installed one (16+) or a portable copy in the agent folder.
$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) {
  $v = & $cmd.Source --version
  if ([int]($v.TrimStart('v').Split('.')[0]) -ge 16) { $node = $cmd.Source }
}
$portable = Join-Path $Dir 'node\node.exe'
if (-not $node -and (Test-Path $portable)) { $node = $portable }
if (-not $node) {
  Say 'Downloading Node.js (portable, only for the agent)...'
  $index = Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json'
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $rel = $index | Where-Object { $_.lts -and ($_.files -contains "win-$arch-zip") } | Select-Object -First 1
  if (-not $rel) { throw 'Could not find a Node.js LTS download; install Node.js 18+ from https://nodejs.org and run this again.' }
  $zip = Join-Path $env:TEMP "node-$($rel.version).zip"
  Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$($rel.version)/node-$($rel.version)-win-$arch.zip" -OutFile $zip
  $tmp = Join-Path $env:TEMP "node-$($rel.version)-extract"
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip -DestinationPath $tmp -Force
  $nodeDir = Join-Path $Dir 'node'
  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName $nodeDir
  Remove-Item $zip -Force
  $node = $portable
}
Say "Node.js: $node ($(& $node --version))"

# 2. The agent.
$agent = Join-Path $Dir 'omada-agent.mjs'
Invoke-WebRequest -UseBasicParsing "$TaskoraUrl/api/v1/integrations/omada/agent/files/omada-agent.mjs" -OutFile $agent
Say "Agent: $agent ($(& $node $agent --version))"

# 3. Configuration (readable by Administrators and SYSTEM only).
$config = [ordered]@{
  taskoraUrl = $TaskoraUrl
  token = $Token
  omadaUrl = $OmadaUrl
  omadaClientId = $ClientId
  omadaClientSecret = $ClientSecret
  omadacId = $OmadaId
  verifyTls = [bool]$VerifyTls
  verifyTaskoraTls = $true
}
$config | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding UTF8
& icacls $cfgPath /inheritance:r /grant:r 'SYSTEM:F' '*S-1-5-32-544:F' | Out-Null

# 4. Test both connections before installing the service.
Say 'Testing the connection to Omada and to Taskora...'
& $node $agent --test --config $cfgPath
if ($LASTEXITCODE -ne 0 -and -not $Force) {
  Say 'The test failed: fix the problem above and run the command again (add -Force to install anyway).' 'Yellow'
  exit 1
}

# 5. Scheduled task: at boot, as SYSTEM, restarted if it stops.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*omada-agent.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$agent`" --config `"$cfgPath`"" -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$runAs = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $runAs -Description 'Sends the Omada sites, devices and clients to Taskora' | Out-Null
Start-ScheduledTask -TaskName $TaskName

Say ''
Say 'Taskora Omada agent installed and running.' 'Green'
Say "  Log:          $(Join-Path $Dir 'agent.log')"
Say "  Settings:     $cfgPath"
Say "  Test again:   & '$node' '$agent' --test --config '$cfgPath'"
Say "  Uninstall:    run the install command again with -Uninstall"
Say 'Next: in Taskora (Omada page > Sites) map each Omada site to its company. The agent sends the data every few minutes.'
