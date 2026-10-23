---
'@nomi-ai/electron': patch
---

fix(mascot): 拖拽 Nomi 时每个指针采样立即移窗，去掉 16.7ms 节流（Windows 定时器精度下会隔帧卡顿，120Hz 屏也受影响）；Windows 拖拽改读系统光标，避免渲染进程 screenX 滞后导致来回抖。
