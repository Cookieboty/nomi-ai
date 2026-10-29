# Electron 2.0.4 基线（固化数据，CI 不再下载 Release 资产）

规则：CI 与本机都不得下载 GitHub Release 资产（会抬高下载计数）。以下数据取自 2026-10-29 的
desktop-go-package 运行 40845629177 / 40850961333（最后一次合法下载），此后只作静态对比。

- `mac-info-plist.txt`：2.0.4 `Nomi.app/Contents/Info.plist`（键 = JSON 值）；`verify-mac.sh` 第 3 参数传入该 .txt 即做键/值对比。
- `win-install-state.txt`：2.0.4 NSIS 静默安装后的注册表/快捷方式/安装目录快照。

| 指标 | Electron 2.0.4 | Go 2.0.5（运行 40850961333） |
|---|---|---|
| Windows 安装目录 | 398.8 MiB（Nomi.exe 246,839,296 B） | 70.9 MiB（Nomi.exe 50,386,944 B） |
| Windows 安装目录路径 | `%LOCALAPPDATA%\Programs\@nomi-aielectron` | 同 |
| Windows 卸载键 | `HKCU\…\Uninstall\b397f92d-158f-5b6d-b066-7aee5a5f3bb7`（无花括号） | 同 |
| Windows `nomi://` | 未注册 | 已注册（D-B11-4） |
| mac `Nomi.app` | — | 80M（arm64） |
| Linux deb 安装 | — | 82M |
