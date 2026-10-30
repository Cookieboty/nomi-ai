---
'@nomi-ai/host-electron': patch
'@nomi-ai/renderer': patch
'@nomi-ai/ai-chat': patch
'@nomi-ai/types': patch
'@nomi-ai/bundle-ig-electron-caps': patch
---

refactor(tts): 移除内置离线语音引擎（安装包不再带原生 addon，也不再有语音模型下载卡片）和系统 speechSynthesis 朗读。旧配置照常启动，已移除的引擎按「无」处理。设置「实时朗读引擎」只保留 无 / Edge / Azure / OpenAI，后三者暂未接入（选中时静默并提示）；保留「诺米提示语音」开关。
