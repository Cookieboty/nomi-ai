---
'@nomi-ai/gateway': patch
---

fix(gateway): count_tokens 透传上游时加上首字节超时，上游不响应时不再无限挂起。
