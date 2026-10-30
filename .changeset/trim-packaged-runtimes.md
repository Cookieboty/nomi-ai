---
'@nomi-ai/host-electron': patch
---

安装包瘦身约 160MB：onnxruntime-web 只打包 Node 下语音检测实际加载的 4 个文件，tesseract.js-core 只保留 Electron 会用到的 relaxedsimd 核心，Chromium 语言包只保留英文与简体中文。
