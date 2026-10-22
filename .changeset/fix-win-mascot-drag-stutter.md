---
'@nomi-ai/electron': patch
'@nomi-ai/renderer': patch
---

fix(mascot): Windows 拖拽卡顿——拖动路径改用 moveWindowTo，尺寸未漂移时不再每帧 setResizable；渲染进程合并 pointermove/mousemove 重复 IPC。
