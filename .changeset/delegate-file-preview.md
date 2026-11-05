---
'@nomi-ai/desktop-go': patch
---

fix(ai-chat): Nomi 委派编程助手（如 Codex）后拿不回改动的文件：子任务卡片补上对话里编辑 / 写入过的文件（git 核对不到的也算），点开在抽屉里预览，Markdown 先显示渲染结果；汇报被截断在代码块中间时不再把后面的正文当成代码。
