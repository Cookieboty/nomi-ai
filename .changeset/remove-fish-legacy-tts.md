---
'@nomi-ai/electron': patch
'@nomi-ai/renderer': patch
'@nomi-ai/ai-chat': patch
'@nomi-ai/types': patch
---

refactor(tts): 移除 Fish 与 legacy 旧音色：删除 Fish（本地 / 云）与自建 legacy 朗读引擎、内置 `nomi` 参考音色及相关设置项和许可说明。旧配置里的 fish-local / fish-cloud / legacy 按「无」加载，不报错。目前没有实现任何实时朗读引擎，AI 普通回复不出声，只有诺米预录提示语音会播放。
