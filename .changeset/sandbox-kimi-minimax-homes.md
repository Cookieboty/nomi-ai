---
'@nomi-ai/desktop-go': patch
---

fix(sandbox): 沙箱不再反复拦 Kimi Code 与 MiniMax Code：它们自己的目录（`~/.kimi-code`、`~/.minimax`）与账号 / 第三方供应商的私有目录照写，选了第三方供应商的标签能读到 Nomi 写好的配置，不会再提示没登录。
