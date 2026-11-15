---
'@nomi-ai/ai-chat': patch
---

fix(ui): 标题栏里会话详情按钮不再压在文件栏开关上：量出开关宽度并在右侧让位；侧栏端信息卡只留端图标，名字保留在 aria-label 与详情抽屉里。 Keep the session details button clear of the files rail toggle in the title bar by reserving the toggle's measured width, and show only the endpoint icon on the sidebar endpoint card (the name stays in the aria-label and the detail drawer).
