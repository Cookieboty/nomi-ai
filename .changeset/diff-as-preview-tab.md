---
'@nomi-ai/ai-chat': patch
---

feat(chat): 右栏「改动」里点文件，在预览区打开这个文件的 Diff 标签，和打开的文件标签同一排，每个改动文件一个；同一文件的 Diff 与文件本身是两个标签，切到文件时 Diff 标签留着，不再在对话旁单独开一栏。/ Clicking a changed file in the right rail now opens a diff tab for that file in the preview area, next to open file tabs (one per file); a file's diff and the file itself are separate tabs, switching between them keeps both, and diffs no longer open in a separate column.
