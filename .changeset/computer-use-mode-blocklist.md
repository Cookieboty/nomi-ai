---
'@nomi-ai/desktop-go': patch
'@nomi-ai/renderer': patch
---

fix(computer-use): 编程助手切到计划模式后立即只能读界面（Codex、Gemini 等长驻会话也一样）；「禁止操作的应用」按名字包含、bundle id 前缀匹配；Linux / Windows 的系统设置也按敏感操作确认；桌面角色上的确认卡补上桌面操作的「记住」文案。/ Coding agents switched to plan mode can only read the UI right away, including long-running Codex and Gemini sessions; blocked apps match by name substring and bundle id prefix; System Settings on Linux and Windows is treated as sensitive; the mascot's confirm card gets the desktop-control remember label.
