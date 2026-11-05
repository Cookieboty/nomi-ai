---
'@nomi-ai/ai-chat': patch
---

fix: 编辑第三方供应商时点「重新检测」，检测期间改的名称、Key、模型设置不再在检测返回后被还原；检测期间改了地址时，旧地址的结果不会套到新地址上（#257）。/ Edits made while a provider re-detect runs (name, keys, model settings) are no longer reverted when it returns, and a result for an address you have since changed is not applied to the new address (#257).
