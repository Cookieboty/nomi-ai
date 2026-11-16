---
'@nomi-ai/ai-chat': patch
---

fix(ui): 标题栏右上角的会话详情按钮紧挨文件栏开关（间距 4px），macOS 上不再空出约 40px；Windows / Linux 的开关仍排在窗口按钮左边，不会压到最小化 / 最大化 / 关闭。 The session details button now sits right next to the files rail toggle in the title bar (4 px apart) instead of ~40 px away on macOS; on Windows / Linux the toggle still stays left of the window controls.
