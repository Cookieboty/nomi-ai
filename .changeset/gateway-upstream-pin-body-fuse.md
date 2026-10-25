---
'@nomi-ai/electron': minor
'@nomi-ai/ai-chat': patch
---

上游出站统一钉 IP 的 undici Agent（防 DNS 重绑定 TOCTOU），有 HTTP(S)_PROXY 时走 EnvHttpProxyAgent；入站请求体默认 32 MiB 上限（可在模型页高级设置调整，超限 413）；网关子进程滑动窗口崩溃熔断（60 秒内 5 次失败停止自动重启，「重试」清零）。
