---
'@nomi-ai/ai-chat': patch
---

fix(chat): keep AutoApproveSetting optimistic pending until tabsChanged matches, and mirror production tabsChanged in the unit test so turning off "auto-approve everything" no longer leaves the switch stuck on true.
