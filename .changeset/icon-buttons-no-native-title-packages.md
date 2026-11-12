---
'@nomi-ai/ui': patch
'@nomi-ai/i18n': patch
---

`IconButton` 不再写原生 title，也不再接受 `title` prop：图标按钮的可访问名只走 aria-label（docs/development/frontend-standards.md「无障碍与提示」）；清掉只用于悬停提示的中英文案 key。
