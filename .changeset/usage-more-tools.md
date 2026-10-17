---
---

feat(usage): read local usage of Qwen Code, OpenCode, GitHub Copilot CLI and Kimi (Kimi CLI / Kimi Code) alongside Claude Code, Codex, dsh, Gemini and Aider — accounting fields only (time, model, token counts), de-duplicated per request. OpenCode (`opencode.db`) and Copilot CLI (`session-store.db`) are opened read-only with Node's built-in `node:sqlite` and only run fixed `SELECT`s on accounting columns, so no native dependency is added; nothing is uploaded and no credentials are read. Each tool's home-directory environment variable is respected (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `QWEN_HOME`, `OPENCODE_HOME` / `XDG_DATA_HOME`, `COPILOT_HOME`, `KIMI_HOME`, `KIMI_CODE_HOME`), and the detected-tools line in the usage panel now shows friendly names for them.
