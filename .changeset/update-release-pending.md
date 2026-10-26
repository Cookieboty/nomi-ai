---
'@nomi-ai/electron': patch
'@nomi-ai/ai-chat': patch
---

修复新版本发布过程中检查更新报 404（#146）：最新 Release 还没有本平台的 latest*.yml 时视为「新版本正在发布中，暂无可用更新」，手动检查给出友好提示、自动检查静默，不再弹出错误堆栈；发版改为先建 draft Release，三端安装包与更新清单都上传并校验通过后再自动发布。
