---
'@nomi-ai/ai-chat': minor
'@nomi-ai/electron': minor
---

Gemini 端点支持第三方供应商档案（API Key、请求地址、模型），交互与其它编程助手一致，输入栏的端点芯片也可切换 Gemini 的官方账号与档案。启用档案不会改动 ~/.gemini：认证方式写在 Nomi 自己的设置文件里，密钥只在 Nomi 启动 Gemini 时注入，终端里直接运行的 gemini 和 Google 登录都不受影响。
