---
'@nomi-ai/gateway': minor
---

feat(gateway): A2 自适应降权——按 (provider,key,wire) 滚动健康样本把不健康/高 degraded 候选排到队尾（不删 Key）；NOMI_ADAPTIVE_ROUTE=0 可关；/metrics 暴露 demotionsActive。
