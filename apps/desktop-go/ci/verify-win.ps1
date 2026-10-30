# 批次 11 Windows 安装器验证：先装 Electron 2.0.4 记录目录/快捷方式/注册表 → 用 Go 版安装器覆盖升级 → 对比 → 启动看到桌面角色 → 卸载。
# 用法：verify-win.ps1 -Setup <Nomi-Setup-x.exe> -Out <dir> [-Old <Nomi-Setup-2.0.4.exe>] [-RequireOld]
# 有 -Old 时模拟 2.0.4 的应用内升级：electron-updater（NsisUpdater.doInstall）在 quitAndInstall(false, true) 后
# 以 `--updated --force-run`（非静默）启动新安装器 → 要求覆盖到同一目录、只剩一个卸载项、旧 Electron 文件清掉、
# 装完自动启动新版本、2.0.4 的用户数据还在。-RequireOld：没有 2.0.4 安装器就判失败（tag 发版用）
param([string]$Setup, [string]$Out, [string]$Old = "", [string]$ElectronExe = "", [switch]$RequireOld)
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
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public struct RECT { public int L, T, Rr, B; }
  public static List<string> List(uint pid) { var o = new List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) { RECT r; GetWindowRect(h, out r); var s = new StringBuilder(256); GetWindowText(h, s, 256);
        o.Add(String.Format("{0}|{1}|{2}|{3}|{4}|{5}|dpi={6}", h, r.L, r.T, r.Rr - r.L, r.B - r.T, s, GetDpiForWindow(h))); } return true; }, IntPtr.Zero); return o; } }
"@
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
function Shot($file, $x = $null) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; if ($x) { $b = $x }
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save($file); $g.Dispose(); $bmp.Dispose() }
$guid = "b397f92d-158f-5b6d-b066-7aee5a5f3bb7"
function InstDir { $l = (Get-ItemProperty "HKCU:\Software\$guid" -ErrorAction SilentlyContinue).InstallLocation; if ($l) { $l } else { "$env:LOCALAPPDATA\Programs\@nomi-aielectron" } }
function Snap($label) {
  $f = Join-Path $Out "state-$label.txt"
  $un = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid"
  & {
    "## uninstall key $guid"; if (Test-Path $un) { Get-ItemProperty $un | Select-Object DisplayName,DisplayVersion,Publisher,DisplayIcon,InstallLocation,UninstallString,QuietUninstallString,NoModify,NoRepair | Format-List | Out-String } else { "(missing)" }
    "## all Nomi uninstall keys"; Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "Nomi*" } | ForEach-Object { $_.PSChildName }
    "## HKCU\Software\$guid"; Get-ItemProperty "HKCU:\Software\$guid" -ErrorAction SilentlyContinue | Select-Object InstallLocation | Format-List | Out-String
    "## nomi protocol"; foreach ($k in "HKCU:\Software\Classes\nomi","HKCU:\Software\Classes\nomi\shell\open\command","HKCU:\Software\Classes\nomi\DefaultIcon") { "$k = " + ((Get-ItemProperty $k -ErrorAction SilentlyContinue).'(default)') }
    "URL Protocol present: " + [bool](Get-ItemProperty HKCU:\Software\Classes\nomi -Name "URL Protocol" -ErrorAction SilentlyContinue)
    "## shortcuts"; foreach ($l in "$env:USERPROFILE\Desktop\Nomi.lnk","$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Nomi.lnk") { if (Test-Path $l) { $s = (New-Object -ComObject WScript.Shell).CreateShortcut($l); "$l -> $($s.TargetPath) [$($s.WorkingDirectory)]" } else { "$l (missing)" } }
    "## install dir"; $d = InstDir; "path: $d"; if (Test-Path $d) { Get-ChildItem $d | Select-Object Name,Length | Format-Table -AutoSize | Out-String; "du: " + [math]::Round(((Get-ChildItem $d -Recurse -File | Measure-Object Length -Sum).Sum)/1MB,1) + " MiB" } else { "(missing)" }
  } | Out-File -Encoding utf8 $f
  return $f }
W "### windows: $(Split-Path $Setup -Leaf) ($((Get-Item $Setup).Length) bytes)"
$sig = Get-AuthenticodeSignature $Setup; W "- Authenticode：$($sig.Status)（Electron 2.0.4 同样未签名）"
$upgrade = $Old -and (Test-Path $Old)
if (-not $upgrade -and $RequireOld) { W "- 缺 Electron 2.0.4 安装器，无法验证 2.0.4 → 新版升级"; $ok = $false }
if ($upgrade) {
  Start-Process -Wait $Old -ArgumentList "/S"; Start-Sleep 5
  # 跑一次 2.0.4 让它写出用户数据（升级后要还在）
  $e = Join-Path (InstDir) "Nomi.exe"; if (Test-Path $e) { Start-Process $e; Start-Sleep 30 }
  Get-Process Nomi -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 3
  $a = Snap "electron-204"; W "- 已安装并运行过 Electron 2.0.4（state-electron-204.txt）"
  $dataBefore = @(Get-ChildItem "$env:APPDATA\Nomi" -Recurse -File -ErrorAction SilentlyContinue).Count
  # = NsisUpdater.doInstall：quitAndInstall(false, true) → ["--updated", "--force-run"]，非静默
  $t = Measure-Command { Start-Process -Wait $Setup -ArgumentList "--updated","--force-run" }
  Start-Sleep 15; $b = Snap "go"; W "- Go 安装器（--updated --force-run，同 2.0.4 应用内升级）用时 $([int]$t.TotalSeconds)s（state-go.txt）"
  $dir = InstDir
  $run = @(Get-Process Nomi -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) })
  W "- 装完自动启动（--force-run）：$(if ($run.Count) { '是' } else { '否' })"; if (-not $run.Count) { $ok = $false }
  Get-Process Nomi -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 3
  $leftover = @("resources\app.asar", "ffmpeg.dll", "libEGL.dll", "chrome_100_percent.pak") | Where-Object { Test-Path (Join-Path $dir $_) }
  W "- 旧 Electron 文件残留：$(if ($leftover) { $leftover -join ', ' } else { '无' })"; if ($leftover) { $ok = $false }
  $keys = @(Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "Nomi*" })
  $ver = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid" -ErrorAction SilentlyContinue).DisplayVersion
  W "- 卸载项：$($keys.Count) 个，DisplayVersion=$ver"; if ($keys.Count -ne 1 -or $ver -eq "2.0.4") { $ok = $false }
  $dataAfter = @(Get-ChildItem "$env:APPDATA\Nomi" -Recurse -File -ErrorAction SilentlyContinue).Count
  W "- 2.0.4 用户数据（%APPDATA%\Nomi）：升级前 $dataBefore 个文件，升级后 $dataAfter 个"; if ($dataBefore -gt 0 -and $dataAfter -eq 0) { $ok = $false }
} else {
  $t = Measure-Command { Start-Process -Wait $Setup -ArgumentList "/S" }
  Start-Sleep 3; $b = Snap "go"; W "- Go 安装器 /S 用时 $([int]$t.TotalSeconds)s（state-go.txt）"
}
if ($upgrade) {
  W "安装状态对比（Electron 2.0.4 → Go 覆盖升级后）"; W '```diff'
  Compare-Object (Get-Content $a) (Get-Content $b) | ForEach-Object { W ("{0} {1}" -f ($(if ($_.SideIndicator -eq '<=') {'-'} else {'+'})), $_.InputObject) }
  W '```'
  $others = (Get-Content $b) -join "`n"
  if ($others -match "\(missing\)") { W "- 有缺失项（见上）"; $ok = $false }
}
function PickMascot($ws) { $ws | Where-Object { $f = $_.Split('|'); [int]$f[3] -ge 200 -and [int]$f[3] -le 700 -and [math]::Abs([int]$f[4] / [math]::Max(1,[int]$f[3]) - 355/330) -lt 0.08 } | Select-Object -First 1 }
W ("- 屏幕：" + [System.Windows.Forms.Screen]::PrimaryScreen.Bounds + "，工作区 " + [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea + "，系统 DPI " + [Wn]::GetDpiForSystem())
$EMascot = $null
if ($ElectronExe -and (Test-Path $ElectronExe)) {
  # 同 runner、全新 userData 启动源码构建的 Electron 2.0.4，量桌面角色窗口（尺寸基线）
  Remove-Item -Recurse -Force "$env:APPDATA\Nomi","$env:APPDATA\@nomi-ai" -ErrorAction SilentlyContinue
  $ep = Start-Process $ElectronExe -PassThru; Start-Sleep 45
  $ews = @(); Get-Process -Name Nomi -ErrorAction SilentlyContinue | ForEach-Object { $ews += [Wn]::List([uint32]$_.Id) }
  $ews | Out-File -Encoding utf8 (Join-Path $Out "windows-electron-204.txt")
  Shot (Join-Path $Out "win-electron-204-fullscreen.png")
  $em = PickMascot $ews
  if ($em) { $f = $em.Split('|'); $EMascot = "$($f[3])x$($f[4])"; Shot (Join-Path $Out "win-electron-204-mascot.png") (New-Object System.Drawing.Rectangle ([int]$f[1]), ([int]$f[2]), ([int]$f[3]), ([int]$f[4])); W "- Electron 2.0.4（源码构建）桌面角色窗口 $EMascot（$($f[6])）" }
  else { W "- Electron 2.0.4（源码构建）未找到桌面角色窗口（windows-electron-204.txt）" }
  Get-Process Nomi -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 3
  Remove-Item -Recurse -Force "$env:APPDATA\Nomi","$env:APPDATA\@nomi-ai" -ErrorAction SilentlyContinue
} else { W "- 无 Electron 2.0.4 构建，跳过同机尺寸对比" }
$exe = Join-Path (InstDir) "Nomi.exe"
if (-not (Test-Path $exe)) { W "- 安装目录里没有 Nomi.exe"; $ok = $false }
else {
  $p = Start-Process $exe -PassThru -RedirectStandardError (Join-Path $Out "go-stderr.log") -RedirectStandardOutput (Join-Path $Out "go-stdout.log"); Start-Sleep 45
  $ws = [Wn]::List([uint32]$p.Id); $ws | Out-File -Encoding utf8 (Join-Path $Out "windows.txt")
  Shot (Join-Path $Out "win-launch-fullscreen.png")
  $m = PickMascot $ws
  if ($m) { $f = $m.Split('|'); Shot (Join-Path $Out "win-mascot.png") (New-Object System.Drawing.Rectangle ([int]$f[1]), ([int]$f[2]), ([int]$f[3]), ([int]$f[4]))
    W "- 启动：PID $($p.Id)，桌面角色窗口 $($f[3])x$($f[4])（$($f[6])）已显示（win-mascot.png）"
    if ($EMascot -and $EMascot -ne "$($f[3])x$($f[4])") { W "- 尺寸与 Electron 2.0.4 不一致：$EMascot vs $($f[3])x$($f[4])"; $ok = $false } }
  else { W "- 启动后未找到桌面角色窗口（windows.txt）"; $ok = $false }
  W ("- 进程：" + ((Get-Process -Id $p.Id -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path)))
  Get-Process Nomi -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 2
  Get-ChildItem "$env:APPDATA\Nomi" -Filter *.json -ErrorAction SilentlyContinue | Where-Object Length -lt 200000 | ForEach-Object { Copy-Item $_.FullName (Join-Path $Out ("go-userdata-" + $_.Name)) }
}
$q = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid" -ErrorAction SilentlyContinue).QuietUninstallString
if ($q) { # 不用 cmd /c：引号路径 + 参数会被 cmd 剥掉外层引号而什么都不执行
  if ($q -match '^"([^"]+)"\s*(.*)$') { Start-Process -Wait -FilePath $Matches[1] -ArgumentList $Matches[2] } else { W "- QuietUninstallString 格式异常：$q"; $ok = $false }
  # NSIS 卸载器会把自身复制到 %TEMP% 再运行（Au_.exe），父进程立即返回：轮询等待
  for ($i = 0; $i -lt 60 -and (Test-Path $exe); $i++) { Start-Sleep 1 }; Start-Sleep 3
  $c = Snap "after-uninstall"; $txt = (Get-Content $c) -join "`n"
  $gone = -not (Test-Path $exe) -and -not (Test-Path "$env:USERPROFILE\Desktop\Nomi.lnk") -and -not (Test-Path HKCU:\Software\Classes\nomi)
  W "- 卸载（QuietUninstallString）：程序/快捷方式/协议已清除=$gone；用户数据 %APPDATA%\Nomi 保留=$(Test-Path "$env:APPDATA\Nomi")"
  if (-not $gone) { $ok = $false } }
else { W "- 无 QuietUninstallString"; $ok = $false }
W $(if ($ok) { "**windows verify: PASS**" } else { "**windows verify: FAIL**" })
Get-Content $R
if (-not $ok) { exit 1 }
