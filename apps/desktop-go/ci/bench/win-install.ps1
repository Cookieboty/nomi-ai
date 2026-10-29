# 静默安装 NSIS 安装包，记录安装耗时与安装后目录大小（KiB）到 sizes.tsv
param([string]$Setup, [string]$Label, [string]$Sizes)
$t = Measure-Command { Start-Process -Wait $Setup -ArgumentList "/S" }
Start-Sleep 5; Get-Process Nomi -ErrorAction SilentlyContinue | Stop-Process -Force
$d = "$env:LOCALAPPDATA\Programs\@nomi-aielectron"
$kb = [math]::Round(((Get-ChildItem $d -Recurse -File | Measure-Object Length -Sum).Sum) / 1KB)
Add-Content $Sizes "$Label`tinstalled`t$kb"
Add-Content $Sizes "$Label`tinstall_seconds`t$([math]::Round($t.TotalSeconds,1))"
