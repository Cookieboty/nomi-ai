---
'@nomi-ai/renderer': patch
'@nomi-ai/host-electron': patch
---

fix: 光标移出诺米后立刻停住时，窗口会一直保持可点击（离开去抖没有后续事件来结算），现在去抖在无新事件时也会继续结算，透明区域恢复点击穿透；Grok 生成图片的 session 根目录改按 realpath 比较（macOS 下 HOME 经 /var → /private/var 符号链接时图片被误拒）。
