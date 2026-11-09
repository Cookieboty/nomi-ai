---
'@nomi-ai/desktop-go': patch
---

fix(sandbox): 开着沙箱时，用第三方供应商的 dsh 标签能正常启动了（之前读不到 Nomi 为它写的配置，启动就退出「dsh 退出码 1」）。各编程助手第三方模式下的私有目录都在沙箱里放行。
