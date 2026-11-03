---
'@nomi-ai/gateway': minor
'@nomi-ai/core': minor
---

feat(gateway): 同一个模型配了多家第三方供应商时，一家失败（429 / 5xx / 超时）先在同一个 Key 上退避重连，再按列表顺序换到下一家；「模型」页可拖动调整顺序、每行开关启用，停用的直接跳过。
