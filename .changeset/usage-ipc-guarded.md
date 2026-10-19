---
'@nomi-ai/electron': patch
---

fix(security): the `ai:usage:*` IPC channels (usage settings, quota hook, scan, clear …) now go through the shared `guardedHandle`, so a trusted window can no longer be driven by an untrusted embedded frame and the channels are claimed in the global registry. The #30 regression test now also flags `ipcMain` registrations whose channel name is passed as a variable.
