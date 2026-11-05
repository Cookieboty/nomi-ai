---
---

perf(chat): each turn sends fewer tool definitions to the model. `avatar_gesture` / `avatar_emotion`
are left out while the desktop character is turned off, and `task_propose` / `task_recall` are sent only
when the conversation talks about doing something later, on a schedule or when something happens (or
asks about a task). The `when` schema of `task_propose` is shorter with the same fields and limits.
