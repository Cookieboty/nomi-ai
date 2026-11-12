---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

fix(computer): Windows 上打开「设置 → Computer Use」不再不停弹出命令行窗口。检查 agent-desktop 和 npm 时不建控制台，短时间内重复的状态查询会合并。内置应用黑名单按词匹配，不再把 Timekeeper 当成密码管理器；GNOME Settings 算系统设置；Wayland 也认 WAYLAND_DISPLAY。
