---
'@nomi-ai/ai-chat': patch
---

fix(chat): 定时任务选「执行档位」时只保存档位，不再把保存当时的 agent / 账号 / 模型一起落盘，档位改了以后按当前档位执行；「执行方式与模型」浮层按草稿当前来源（本机登录 / 官方账号）读取模型目录，切来源后不再显示另一边的模型。 Scheduled tasks that target a preset now save only the preset, so edits to it apply at trigger time; the runner picker reads the model catalog for the selected source (local sign-in vs official account) instead of always the official one.
