---
'@nomi-ai/ai-chat': patch
'@nomi-ai/host-electron': patch
---

修复 Gemini 的版本检查：之前保存的「最新版本」缓存里没有 Gemini 时会立即重新获取，不再要等 6 小时；更新 Gemini 只用 npm，不再尝试不存在的 `gemini update`；版本卡片拿不到数据时显示「无法检测」而不是「已安装」；本机 Gemini CLI 过旧、不支持 ACP 时提示先更新。
