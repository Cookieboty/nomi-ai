---
'@nomi-ai/host-electron': patch
'@nomi-ai/core': patch
---

fix(core): bubbles for files dropped on the mascot, terminal scripts regenerated from the tray model picker and other host callbacks follow the chosen interface language again: calls outside a core scope use the only live core, and the host enters `core.run()` at those entry points.
