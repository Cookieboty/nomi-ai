---
'@nomi-ai/desktop-go': patch
---

chore: add storage-independent conversation runtime handoff foundations for 2.5.0

Add bounded full/delta planning, exact complete-prompt JSON byte budgets, and in-memory revision-aware delivery coverage with regression tests. This foundation is not connected to production chat, local CLI processes, or user data; providerless main chat is not yet available.
