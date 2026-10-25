---
'@nomi-ai/cli-sdk': minor
'@nomi-ai/cli-plugins': minor
'@nomi-ai/ui': patch
---

Permission PR3: Claude `ExitPlanMode` (and mapped CLIs) surfaces an 「批准计划」card — approve and auto-edit / approve with step-by-step confirm / keep editing. Approve allows the tool and writes back the chosen permission mode; reject stays in plan mode. Codex/dsh/Grok offer a post-turn 「按此方案执行」card. `HarnessEvent` permission gains optional `kind`/`toolName`; status may carry `permissionMode` for label sync. Design: docs/design/cli-permission-modes.md §5.
