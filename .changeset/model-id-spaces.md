---
'@nomi-ai/cli-sdk': patch
'@nomi-ai/host-electron': patch
'@nomi-ai/ai-chat': patch
---

fix(cli): models whose id contains spaces (for example a third-party "Qwen 3 Max") can be selected in coding-agent tabs; they used to be rejected as an invalid model name. `/model` matches the whole argument against the model id, `provider/model` and the display name, so `/model Opus 5.5` switches directly instead of listing every partial match, and `/model ` completion keeps going after a space. Line breaks, tabs, repeated spaces and quotes are still refused.
