---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

fix(sidebar): 侧栏层级更清楚：分区标题改成小号灰字，项目名比会话标题重一档，「展开显示」改成小字「再显示 N 条」，当前会话的底色浅一档、标题加粗，标题栏图标统一大小、颜色浅一档。从本机历史打开的会话不再把 Nomi 附带的沙箱说明当成标题；以前用错的标题，以及说过话还叫「Claude Code 11」这类默认名的标签，启动时按第一句提问重新起标题。 / Clearer sidebar hierarchy: section labels are small and muted, project names are one weight heavier than session titles, "Show more" becomes a small "Show N more", the current session gets a lighter background with a medium-weight title, and header icons share one size and a lighter color. Sessions opened from local history no longer take the sandbox note Nomi sends as their title; at startup, titles that used it, and tabs that were used but still have a default name like "Claude Code 11", are retitled from the first prompt.
