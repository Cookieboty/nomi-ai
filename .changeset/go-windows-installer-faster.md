---
'@nomi-ai/ai-chat': patch
---

fix(desktop-go): Windows 上覆盖安装 Go 版（包括应用内更新）不再先跑一遍旧版本的卸载器；没有在运行的 Nomi 时不再固定等待；WebView2 运行时按微软的方式检查三处注册表，已经装了就不会再去下载。安装器把每一步的耗时写到 `%TEMP%\nomi-install.log`，方便排查安装慢的问题。
