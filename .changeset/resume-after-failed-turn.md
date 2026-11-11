---
'@nomi-ai/desktop-go': patch
---

fix(cli): 编程助手第一轮出错（如供应商 API 400）后，下一轮（包括沙箱授权后的「请继续」）会接上原来的会话，不再变成一个什么都不记得的新会话；Claude Code 启动时就记下会话 id，Gemini 等 ACP 编程助手同理。/ After a coding assistant's first turn fails (for example an upstream API 400), the next turn, including "continue" after granting sandbox access, resumes the same session instead of starting a new one that remembers nothing. Claude Code's session id is now recorded as soon as it starts, and the same applies to ACP assistants such as Gemini.
