---
---

test(fleet): in Mock CLI mode (`NOMI_USE_MOCK_CLI=1`, site screenshots and E2E) the agent board lists only Nomi's own processes, so real coding agents on the machine never show up in screenshots; the site screenshots gain an `agent-board` scene, and the mock CLIs honour `NOMI_MOCK_SLOW_PROMPT` on every delay path.
