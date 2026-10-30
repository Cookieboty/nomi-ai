---
'@nomi-ai/host-electron': patch
---

fix(packaging): 打包后不再解开并重建 app.asar，保留 electron-builder 生成的 header，tesseract.js / tesseract.js-core / onnxruntime-web 的 unpacked 条目按原路径可加载（知识库 OCR、Silero VAD）；非当前平台的 bare-* prebuilds 改在打包输入阶段裁掉，afterPack 只校验 unpacked 条目都在 header 里（#188）。
