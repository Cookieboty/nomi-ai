---
'@nomi-ai/ui': patch
---

feat(ui): date and time fields (schedule times, quiet hours, reminder time, quality date range) open Nomi's own calendar / hour-minute picker instead of the system one, with keyboard navigation and the interface language (new `DateTimeField`; `Input` picks it for `type="date|time|datetime-local"`).
