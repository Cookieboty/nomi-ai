---
'@nomi-ai/host-electron': patch
---

fix(reminders): when the mascot is closed (hidden) or has no window, reminders — including missed ones — are no longer sent to the hidden mascot. They go to the Dynamic Island and, if system notifications are turned on, a system notification instead; clicking the notification opens the chat window.
