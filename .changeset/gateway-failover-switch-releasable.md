---
'@nomi-ai/contract': patch
'@nomi-ai/i18n': patch
---

feat(gateway): 熔断降级开关进入契约：`gateway.setOptions` 接受 `failoverEnabled`，`gateway.state()` 返回它；「三方供应商」卡片右上角的开关、说明与「开启熔断降级后才会自动换供应商」提示新增中英文案。/ The circuit-breaker switch becomes part of the contract: `gateway.setOptions` accepts `failoverEnabled` and `gateway.state()` reports it; the switch in the Third-Party Providers card header, its tooltip and the updated provider-order hint gain their zh/en strings.
