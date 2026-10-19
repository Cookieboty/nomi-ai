---
'@nomi-ai/electron': patch
---

fix(reminders): when the mascot is closed (hidden) or has no window, reminders — including missed ones — are no longer sent to the hidden mascot. They go to the Dynamic Island and a system notification instead, and clicking the notification opens the chat window. If the island cannot show it, a system notification is sent even when system notifications are turned off, so a reminder is never silently lost.
