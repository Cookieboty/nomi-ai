---
'@nomi-ai/desktop-go': patch
---

feat(board): Agent 看板与任务看板改版：Agent 看板按状态筛选、可搜索和按助手类型筛选，卡片两列铺开，写清状态、来源、目录与 CPU / 内存，底部一栏显示 Nomi 自己的占用与内存守护最近做的事；任务看板列头用色点、卡片带类型图标与执行者，可按进度筛选和搜索，卡片上可直接立即运行或暂停，已结束的收成紧凑一行。配色统一跟随主题色，只显示真实数据（内核没有完成度，不画百分比）。/ Redesigned Agent and task boards: the Agent board filters by status, search and agent type, shows two columns of cards with status, source, folder and CPU / memory, and a footer with Nomi's own usage and what the memory guard did recently; the task board has colored column dots, cards with a type icon and executor, filtering by stage and search, run now or pause right on the card, and finished tasks collapse to a compact row. Colors follow the theme and only real data is shown (no made-up progress percentages).
