# 批次 11 Windows 安装器验证：先装 Electron 2.0.4 记录目录/快捷方式/注册表 → 用 Go 版安装器覆盖升级 → 对比 → 启动看到看板娘 → 卸载。
# 用法：verify-win.ps1 -Setup <Nomi-Setup-x.exe> -Out <dir> [-Old <Nomi-Setup-2.0.4.exe>]
param([string]$Setup, [string]$Out, [string]$Old = "")
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force $Out | Out-Null
$R = Join-Path $Out "report.md"; $ok = $true
function W($s) { Add-Content -Encoding utf8 $R $s }
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class Wn {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public struct RECT { public int L, T, Rr, B; }
  public static List<string> List(uint pid) { var o = new List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) { RECT r; GetWindowRect(h, out r); var s = new StringBuilder(256); GetWindowText(h, s, 256);
        o.Add(String.Format("{0}|{1}|{2}|{3}|{4}|{5}", h, r.L, r.T, r.Rr - r.L, r.B - r.T, s)); } return true; }, IntPtr.Zero); return o; } }
"@
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
function Shot($file, $x = $null) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; if ($x) { $b = $x }
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save($file); $g.Dispose(); $bmp.Dispose() }
$guid = "{b397f92d-158f-5b6d-b066-7aee5a5f3bb7}"
function Snap($label) {
  $f = Join-Path $Out "state-$label.txt"
  $un = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid"
  & {
    "## uninstall key $guid"; if (Test-Path $un) { Get-ItemProperty $un | Select-Object DisplayName,DisplayVersion,Publisher,DisplayIcon,InstallLocation,UninstallString,QuietUninstallString,NoModify,NoRepair | Format-List | Out-String } else { "(missing)" }
    "## other Nomi uninstall keys"; Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "Nomi*" } | ForEach-Object { $_.PSChildName }
    "## HKCU\Software\$($guid.Trim('{}'))"; Get-ItemProperty "HKCU:\Software\$($guid.Trim('{}'))" -ErrorAction SilentlyContinue | Select-Object InstallLocation | Format-List | Out-String
    "## nomi protocol"; foreach ($k in "HKCU:\Software\Classes\nomi","HKCU:\Software\Classes\nomi\shell\open\command","HKCU:\Software\Classes\nomi\DefaultIcon") { "$k = " + ((Get-ItemProperty $k -ErrorAction SilentlyContinue).'(default)') }
    "URL Protocol present: " + [bool](Get-ItemProperty HKCU:\Software\Classes\nomi -Name "URL Protocol" -ErrorAction SilentlyContinue)
    "## shortcuts"; foreach ($l in "$env:USERPROFILE\Desktop\Nomi.lnk","$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Nomi.lnk") { if (Test-Path $l) { $s = (New-Object -ComObject WScript.Shell).CreateShortcut($l); "$l -> $($s.TargetPath) [$($s.WorkingDirectory)]" } else { "$l (missing)" } }
    "## install dir"; $d = "$env:LOCALAPPDATA\Programs\Nomi"; if (Test-Path $d) { Get-ChildItem $d | Select-Object Name,Length | Format-Table -AutoSize | Out-String; "du: " + [math]::Round(((Get-ChildItem $d -Recurse -File | Measure-Object Length -Sum).Sum)/1MB,1) + " MiB" } else { "(missing)" }
  } | Out-File -Encoding utf8 $f
  return $f }
W "### windows: $(Split-Path $Setup -Leaf) ($((Get-Item $Setup).Length) bytes)"
$sig = Get-AuthenticodeSignature $Setup; W "- Authenticode：$($sig.Status)（Electron 2.0.4 同样未签名）"
if ($Old -and (Test-Path $Old)) {
  Start-Process -Wait $Old -ArgumentList "/S"; Start-Sleep 5; Get-Process Nomi -ErrorAction SilentlyContinue | Stop-Process -Force
  $a = Snap "electron-204"; W "- 已安装 Electron 2.0.4（state-electron-204.txt）"
}
$t = Measure-Command { Start-Process -Wait $Setup -ArgumentList "/S" }
Start-Sleep 3; $b = Snap "go"; W "- Go 安装器 /S 用时 $([int]$t.TotalSeconds)s（state-go.txt）"
if ($Old -and (Test-Path $Old)) {
  W "安装状态对比（Electron 2.0.4 → Go 覆盖升级后）"; W '```diff'
  Compare-Object (Get-Content $a) (Get-Content $b) | ForEach-Object { W ("{0} {1}" -f ($(if ($_.SideIndicator -eq '<=') {'-'} else {'+'})), $_.InputObject) }
  W '```'
  $others = (Get-Content $b) -join "`n"
  if ($others -match "\(missing\)") { W "- 有缺失项（见上）"; $ok = $false }
}
$exe = "$env:LOCALAPPDATA\Programs\Nomi\Nomi.exe"
if (-not (Test-Path $exe)) { W "- 安装目录里没有 Nomi.exe"; $ok = $false }
else {
  $p = Start-Process $exe -PassThru; Start-Sleep 45
  $ws = [Wn]::List([uint32]$p.Id); $ws | Out-File -Encoding utf8 (Join-Path $Out "windows.txt")
  Shot (Join-Path $Out "win-launch-fullscreen.png")
  $m = $ws | Where-Object { $f = $_.Split('|'); [int]$f[3] -ge 320 -and [int]$f[3] -le 500 -and [int]$f[4] -ge 345 -and [int]$f[4] -le 540 } | Select-Object -First 1
  if ($m) { $f = $m.Split('|'); Shot (Join-Path $Out "win-mascot.png") (New-Object System.Drawing.Rectangle ([int]$f[1]), ([int]$f[2]), ([int]$f[3]), ([int]$f[4]))
    W "- 启动：PID $($p.Id)，看板娘窗口 $($f[3])x$($f[4]) 已显示（win-mascot.png）" }
  else { W "- 启动后未找到看板娘窗口（windows.txt）"; $ok = $false }
  W ("- 进程：" + ((Get-Process -Id $p.Id -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path)))
  Get-Process Nomi -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 2
}
$q = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid" -ErrorAction SilentlyContinue).QuietUninstallString
if ($q) { Start-Process -Wait cmd.exe -ArgumentList "/c $q"; Start-Sleep 5
  $c = Snap "after-uninstall"; $txt = (Get-Content $c) -join "`n"
  $gone = -not (Test-Path "$env:LOCALAPPDATA\Programs\Nomi\Nomi.exe") -and -not (Test-Path "$env:USERPROFILE\Desktop\Nomi.lnk") -and -not (Test-Path HKCU:\Software\Classes\nomi)
  W "- 卸载（QuietUninstallString）：程序/快捷方式/协议已清除=$gone；用户数据 %APPDATA%\Nomi 保留=$(Test-Path "$env:APPDATA\Nomi")"
  if (-not $gone) { $ok = $false } }
else { W "- 无 QuietUninstallString"; $ok = $false }
W $(if ($ok) { "**windows verify: PASS**" } else { "**windows verify: FAIL**" })
Get-Content $R
if (-not $ok) { exit 1 }
