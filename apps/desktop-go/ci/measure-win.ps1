# CI 内存测量（Windows）。用法：measure-win.ps1 -Mode poc|electron -Bin <exe> -Out <dir>
# 口径：私有工作集（Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate）+ PrivateMemorySize64（提交的私有内存）+ WorkingSet64，整棵进程树。
param([string]$Mode, [string]$Bin, [string]$Out)
$ErrorActionPreference = 'Continue'
$wait = if ($env:WAIT) { [int]$env:WAIT } else { 45 }
New-Item -ItemType Directory -Force $Out | Out-Null
$ctl = '127.0.0.1:47811'
function Ctl($op) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://$ctl/ctl?op=$op" | Out-Null } catch { Write-Host "ctl $op failed: $_" } }
function Tree($root) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
  $set = @($root); $changed = $true
  while ($changed) { $changed = $false; foreach ($p in $all) { if ($set -contains $p.ParentProcessId -and -not ($set -contains $p.ProcessId)) { $set += $p.ProcessId; $changed = $true } } }
  $all | Where-Object { $set -contains $_.ProcessId }
}
function Shot($label) {
  try { Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save("$Out\$Mode-$label.png"); } catch { Write-Host "screenshot failed: $_" }
}
function Snap($label) {
  $perf = @{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $perf[[int]$_.IDProcess] = $_.WorkingSetPrivate }
  $rows = foreach ($p in (Tree $script:root)) {
    $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue; if (-not $gp) { continue }
    $role = if ($p.CommandLine -match '--type=([\w-]+)') { $Matches[1] } else { 'main' }
    [pscustomobject]@{ pid = $p.ProcessId; name = $p.Name; type = $role
      privWS_MiB = [math]::Round($perf[[int]$p.ProcessId] / 1MB, 1); private_MiB = [math]::Round($gp.PrivateMemorySize64 / 1MB, 1); ws_MiB = [math]::Round($gp.WorkingSet64 / 1MB, 1) }
  }
  $rows | Export-Csv -NoTypeInformation "$Out\$Mode-$label.csv"
  Write-Host "== $label"; $rows | Format-Table -AutoSize | Out-String | Write-Host
}
Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory | Out-File "$Out\$Mode-mem-before.txt"
if ($Mode -eq 'poc') { $env:NOMI_POC_CTL = $ctl }
$proc = Start-Process -FilePath $Bin -PassThru -RedirectStandardOutput "$Out\$Mode-app.log" -RedirectStandardError "$Out\$Mode-app.err.log"
$script:root = $proc.Id; Write-Host "root=$($proc.Id) wait=${wait}s"
Start-Sleep $wait; Shot cold
1..3 | ForEach-Object { Snap "cold-$_"; Start-Sleep 5 }
if ($Mode -eq 'poc') {
  foreach ($i in 1..3) { Ctl show-chat; Start-Sleep 10; if ($i -eq 1) { Shot chat-open }; Snap "chat-open-$i"; Ctl close-chat; Start-Sleep 10; Snap "chat-closed-$i" }
  # 渲染器切换：svg（默认）→ rive → svg，各截图 + 三次快照
  Shot mascot-svg; foreach ($i in 1..3) { Snap "renderer-svg-start-$i"; Start-Sleep 5 }
  Ctl 'renderer&v=rive'; Start-Sleep 15; Shot mascot-rive; foreach ($i in 1..3) { Snap "renderer-rive-$i"; Start-Sleep 5 }
  Ctl 'renderer&v=svg'; Start-Sleep 15; Shot mascot-svg-back; foreach ($i in 1..3) { Snap "renderer-svg-back-$i"; Start-Sleep 5 }
  Ctl hide-mascot; foreach ($i in 1..3) { Start-Sleep 10; Snap "mascot-hidden-$i" }
  Ctl quit
}
Start-Sleep 2; Tree $script:root | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
