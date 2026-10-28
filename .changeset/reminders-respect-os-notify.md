---
'@nomi-ai/host-electron': patch
---

fix(reminders): when the mascot is hidden and the Dynamic Island can't show a reminder, Nomi no longer sends a system notification if you have turned system notifications off. The reminder is recorded in the audit log as not shown.
