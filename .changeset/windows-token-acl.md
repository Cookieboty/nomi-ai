---
'@nomi-ai/electron': patch
---

fix(electron): Windows 上私有令牌/配置文件写后用 icacls 收紧 ACL（去继承、仅当前用户），补齐 POSIX 0600 在 win32 无效的缺口；令牌目录走 ensurePrivateDir。
