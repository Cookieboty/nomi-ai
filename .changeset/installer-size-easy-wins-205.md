---
'@nomi-ai/electron': patch
---

安装包瘦身（easy wins）：去掉 asarUnpack 在 asar 内的 onnx/tesseract 重复副本；bare-* prebuilds 只留当前平台；zlibjs 只留 node-zlib.js；i18n 不打包 src/ESM dist；assets 仅走 extraResources。
