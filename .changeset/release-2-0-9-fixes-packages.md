---
'@nomi-ai/ui': patch
---

fix: `Modal` 新增 `layer="top"`（`--cd-z-modal-top`），确认 / 输入框盖在引导等整页浮层之上。命令自动审核：MCP 工具、`memory_search`、`skill_load` / `skill_read_file` 的返回也把本轮标为读过外部内容（之后中风险命令交给人确认）；审核结论逐个解析配平的 JSON 片段，不再用贪婪正则，多段结论取风险最高的。素材库排序用 birthtime 与 mtime 中较早的一个。Node 与 Go 版一致。
