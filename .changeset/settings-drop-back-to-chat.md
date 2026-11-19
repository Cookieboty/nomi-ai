---
'@nomi-ai/ai-chat': patch
---

chore(settings): 设置侧栏顶部去掉「返回对话」入口，目录直接以「通用 / Nomi / 能力…」分组开头；关闭设置仍可用 Esc（说明里一直写着 Esc）。同时移除随之变成死 key 的 `ui.chat-settings.back-to-chat` 与 `back-to-chat-esc`。/ Remove the "Back to chat" row from the top of the settings sidebar so the section list starts right away; Esc still closes settings (the shortcut it advertised). The now-dead `ui.chat-settings.back-to-chat` and `back-to-chat-esc` keys are dropped.
