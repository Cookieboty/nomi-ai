---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

fix(chat): 修复设置页官方账号登录弹窗被当作内嵌面板、关闭后被迟到事件重新打开，以及启动响应覆盖登录进度的问题；设备码就绪后自动打开浏览器一次；Grok 改用官方浏览器回调登录，不再强制设备码流程。/ Fix official account sign-in rendering inline, late events reopening dismissed dialogs, and startup responses overwriting sign-in progress; open the browser once when a device code is ready, and use Grok's browser OAuth flow instead of forcing device authentication.
