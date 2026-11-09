---
'@nomi-ai/avatar-runtime': patch
---

fix(avatar): macOS 上关闭 Rive 动画后，静态立绘首次显示、重新打开「显示」或从 Rive 切回静态时不再是空白（之前要调整大小才出现）：先解码再画、画布布局好后再画，画出来是空的就自己重画（#303）。
