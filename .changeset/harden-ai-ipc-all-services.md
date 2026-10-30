---
'@nomi-ai/host-electron': patch
---

fix(electron): every service-registered ai:* IPC channel (desktop capabilities, MCP / skills, memory, knowledge base, scheduler, voice, screen, local models, calendar hub, CLI history / update, theme, language, updates, onboarding) now goes through the shared sender guard like the chat and CLI channels: an untrusted window or sub-frame can no longer flip local-only mode, change tool policies, add or start MCP servers, or read / edit memory and the knowledge base.
