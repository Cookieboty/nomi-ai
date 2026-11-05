---
---

perf: smoother streaming and lower idle CPU and memory. While a reply streams, the chat root and the
sidebar no longer re-render every frame; chat history is written when idle (always before switching
or closing, and a full storage is logged instead of silently dropping writes); sidebar search no longer
parses every conversation; long traces fold incrementally; production builds skip per-frame schema
checks for stream chunks and high-frequency events. The desktop character drops its frame rate when
idle and skips unchanged frames (talking, blinking and gestures stay at full rate). The usage ledger
shares repeated values across records and uses about half the memory.
