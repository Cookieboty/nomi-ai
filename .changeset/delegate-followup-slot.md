---
'@nomi-ai/electron': patch
---

fix(delegate): follow-ups on a finished handoff now count toward the limit of 3 handoffs running at once, and handoffs started at the same moment can no longer slip past the limit together. Rejected or failed handoffs free their slot (#141).
