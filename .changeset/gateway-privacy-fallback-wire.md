---
'@nomi-ai/gateway': patch
---

fix(privacy): outbound protection now also covers requests that start on a local endpoint and then retry on the same provider's cloud endpoint (learned protocol switch or short-term suppression). The masked body is computed right before the first cloud attempt, and keys set to "block" stop the request instead of reaching the cloud (#150).
