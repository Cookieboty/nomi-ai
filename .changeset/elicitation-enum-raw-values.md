---
'@nomi-ai/desktop-go': patch
---

fix(mcp): MCP 表单提问的选项值原样回传：带首尾空格或超过 200 字的 enum 成员不再被修剪、截断，答复仍属于原枚举；只有显示文字会被整理。
