---
'@nomi-ai/ai-chat': patch
---

fix(chat): 其他 CLI 端（Claude Code、Codex、Grok、Gemini、dsh）新建对话与 Nomi 一致：同一个项目里这个端已经有一个还没说过话的空会话时，直接切过去，不再每次点新建都开一个新标签。之前侧栏会堆一串空会话，每个还占着一个 CLI 进程。/ Creating a new chat on the other CLI endpoints (Claude Code, Codex, Grok, Gemini, dsh) now behaves like Nomi: if the endpoint already has an untouched chat in that project, it switches to it instead of opening another tab, so the sidebar no longer fills up with empty chats that each hold a CLI process.
