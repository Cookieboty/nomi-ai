---
---

fix(electron): quitting the app (menu, Cmd/Ctrl+Q or SIGTERM/SIGINT) now waits for a real shutdown, with a 5s safety timeout, before exiting; previously the process could exit before cleanup finished. fix(electron): on quit the CLI harness kills running Claude/Codex/dsh processes together with the tools they spawned, the local route closes its keep-alive connections, and the knowledge base stops its indexing timers, downloads and OCR worker instead of leaving them behind.
