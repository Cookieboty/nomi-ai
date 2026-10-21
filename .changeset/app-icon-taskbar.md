---
'@nomi-ai/electron': patch
'@nomi-ai/ai-chat': patch
---

切换应用图标时同步 Windows 任务栏（#56）：每个窗口（含之后新建的窗口）调用 setIcon，Windows 上再用 setAppDetails 指向对应变体的 .ico（新增三种变体的多尺寸 .ico）；设置页文案改为如实说明：窗口、运行中的任务栏按钮和托盘立即更新，已固定到任务栏的图标可能要重启应用后才更新。
