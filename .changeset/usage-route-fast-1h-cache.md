---
'@nomi-ai/ai-chat': patch
---

fix(usage): requests that go through the local CLI route now keep Anthropic's fast mode (`usage.speed = fast`) and the 1-hour cache-write tier in the usage ledger, the same as the log reader already did. Previously route-recorded calls were priced as standard speed / 5-minute cache, so cost and budget alerts were too low; a matching tool log also fills in these pricing fields when the route response did not carry them.
