---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

fix(cli-update): 编程助手检测不再因询问 npm 最新版而卡住「检测中 / 正在检查」。本地探测一结束就先展示已安装 / 未安装；latest 在后台刷新并通过 `cliUpdate.event` 补上。inspect 和前端共享 Promise 增加总超时，引导页在检测失败时退出「正在检查…」（#350）。/ Coding-assistant detection no longer stays on "Checking…" while npm latest is fetched. Local install state is shown as soon as the probe finishes; latest versions refresh in the background and arrive via `cliUpdate.event`. inspect (and the renderer shared promise) now has an overall timeout, and the onboarding checklist leaves "Checking…" if detection fails (#350).
