---
'@nomi-ai/cli-sdk': patch
---

Refactor coding-agent harness: move `HarnessOrchestrator` into `cli/harness/*` with a thin `CliHarnessService` facade (same public API). No intentional behavior change; enables permission PR3 and further orchestration cuts.
