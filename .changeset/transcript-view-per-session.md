---
'@nomi-ai/desktop-go': patch
---

对话与编程助手会话新增按会话生效的 Transcript view（#310）：

- 设置 → 通用 → 外观新增全局默认（Normal / Thinking / Verbose）；
- 会话标题栏新增 Transcript view 菜单，可按会话覆盖全局默认，会话级优先；
- Normal 折叠工具调用并隐藏思考；Thinking 显示思考；Verbose 展开每次工具调用与参数 / 输出，并展开思考；
- 选择只影响当前会话，切换会话或重启后保留；会话菜单可恢复「跟随全局设置」。
