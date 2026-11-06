---
'@nomi-ai/ai-chat': patch
---

fix(chat): 输入框里 Home / End 跳到当前行首尾，Shift 扩展选区，Ctrl / Command 跳到全文首尾；输入法组合时不拦截。/ In the composer, Home / End move to the start / end of the current line, Shift extends the selection and Ctrl / Command jumps to the start / end of the text; keys are left alone while an IME is composing.
