---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
'@nomi-ai/types': patch
---

fix(chat): 图片主题改为单层全局蒙版：模糊与不透明度只作用于蒙版，底图不再随模糊放大或裁切；新默认为模糊 0px、蒙版 50%（已有设置保留）；主题预览与实际一致，任务页、委派卡片、素材库和设置面板改用透明面板。/ Image themes now use a single global mask: blur and opacity apply to the mask only, so the picture no longer zooms or crops with the blur value. New defaults are 0px blur and 50% mask (existing settings are kept); the preview matches the real window, and tasks, delegate cards, the asset library and settings panels use translucent panels.
