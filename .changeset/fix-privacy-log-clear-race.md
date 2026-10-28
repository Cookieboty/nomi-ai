---
'@nomi-ai/host-electron': patch
---

fix(privacy): clear / flush the privacy log through the same async write queue as scheduled flushes so an in-flight old snapshot cannot overwrite an emptied file (#164); chat-background startup persist and models-catalog sync also use async atomic writes (#154).
