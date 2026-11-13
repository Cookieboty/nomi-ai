---
'@nomi-ai/desktop-go': patch
---

fix(accounts): 正确解析 Grok ACP 的认证状态响应，修复浏览器授权后被误判为未登录并报告「登录完成了，但 CLI 仍显示未登录」的问题。/ Parse Grok's ACP authentication response before checking account status, fixing successful browser sign-ins being incorrectly reported as signed out.
