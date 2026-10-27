---
'@nomi-ai/gateway': patch
---

fix(privacy): registered custom secrets that contain quotes, backslashes or newlines are now recognised inside JSON-encoded tool-call `arguments` (Chat `tool_calls` and Responses `function_call`). The arguments are parsed, masked on the original values and re-encoded as valid JSON; "block" rules apply there too (#151).
