---
---

fix(diagnostics): gateway request bodies are traced again: the gateway never received the trace
directory, so `gateway/trace/` stayed empty even with diagnostics on (dev builds included). Diagnostic
logs are now on by default for new installs and for users who never touched the switch, so the
execution trace can show request bodies; turning it off in settings is remembered.
