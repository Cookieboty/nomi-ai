---
---

fix(diagnostics): gateway request traces are capped at 256 MB in total (oldest removed first) on
top of the 24-hour limit, and diagnostics that are on only by default no longer switch the app log
to debug level; turning the switch on in settings still does.
