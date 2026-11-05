---
'@nomi-ai/desktop-go': minor
---

feat(updates): 点「重启更新」后直接装好并重新打开，不再让你自己装：macOS 把新版 Nomi.app 换进原位置（下载 `-mac.zip`，校验 SHA-256、签名、Bundle ID 与 Team ID），不用再拖拽；只有 Nomi 不在可写位置（从 dmg 里运行、被系统隔离、目录没有写权限）时才打开 dmg。Windows 静默运行安装程序覆盖升级，不弹安装向导，装完自动启动。从 2.2.0 升级到之后的版本起生效（2.1.x 升级到 2.2.0 仍按旧方式）。/ "Restart to update" now installs and relaunches by itself: on macOS the new Nomi.app replaces the old one in place (verified `-mac.zip`), and the DMG is opened only when the app isn't in a writable location; on Windows the installer runs silently and relaunches Nomi. Takes effect for updates after 2.2.0.
