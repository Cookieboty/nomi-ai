---
'@nomi-ai/gateway': minor
---

网关 RoutePlan 指标聚合：UsageEvent / QualityRecord 带上 losses 与 routeQuality；质量账本可按路由质量与主损失分组；新增进程内 GET /metrics 实时快照（按客户端 / 入口 / 上游 / 路由质量与损失计数 + e2e P50/P95）。
