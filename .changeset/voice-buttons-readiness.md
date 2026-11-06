---
'@nomi-ai/ai-chat': patch
---

fix(voice): 输入栏的麦克风与免按键按钮只在语音识别配好（本地模型已下载或云端识别已配置）时显示；没配好时「+」菜单里有「设置语音输入…」，按 `F2` / 免按键快捷键也直接打开语音设置，不再按了才报错。免按键开着时识别变得不可用，仍保留关掉它的按钮。/ The composer's mic and hands-free buttons only show once speech recognition is set up (a local model downloaded or cloud recognition configured); until then the "+" menu offers "Set up voice input…" and `F2` / the hands-free shortcut open voice settings instead of failing. If recognition becomes unavailable while hands-free is on, its button stays so you can turn it off.
