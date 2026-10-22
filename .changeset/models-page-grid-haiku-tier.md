---
'@nomi-ai/ai-chat': patch
'@nomi-ai/electron': patch
'@nomi-ai/gateway': patch
'@nomi-ai/ui': patch
---

设置页版面与 Claude Code 后台模型：

- 「模型」页各卡片统一列宽，选择框、表头与供应商列表的数字列上下对齐；子项只缩进标签。
- Claude Code 单独的「小模型」并入「Haiku 档 · 后台任务」。启动时 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 与 `ANTHROPIC_SMALL_FAST_MODEL` 取同一个值，修复新版 Claude Code 后台任务不用所设小模型的问题；旧配置里的小模型继续生效。
- 「通用」页顶部横幅高度封顶，宽窗口下不再越拉越高。
