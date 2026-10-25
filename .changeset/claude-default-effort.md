---
'@nomi-ai/electron': patch
'@nomi-ai/ai-chat': patch
---

Claude Code 的默认思考档位：initialize 响应里没有默认档位，改为读 CLAUDE_CODE_EFFORT_LEVEL 与设置里保存的 effortLevel 标在滑杆上；都没有时说明「由 Claude Code 按模型决定」，不再显示空滑杆。
