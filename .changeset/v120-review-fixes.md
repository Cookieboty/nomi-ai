---
'@nomi-ai/ai-chat': patch
'@nomi-ai/electron': patch
---

fix(workspace): 撤销/丢弃本轮变更只把改动处换回旧内容，文件之后又被改过则拒绝，不再用一小段 diff 覆盖整个文件；预览面板的丢弃改为应用内确认；全屏 Review 按 Esc 只关全屏；拖过的对话列宽会被记住；中间预览栏不再被挤到看不见保存按钮。
