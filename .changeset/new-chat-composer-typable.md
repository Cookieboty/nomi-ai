---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

fix(chat): 修好「新建会话后输入框打不了字」。关掉或藏起内置浏览器时，如果键盘焦点还在网页里，现在会交还给对话页面。之前 macOS 和 Windows 上光标看着在输入框里，按键却全被藏起来的网页吃掉。新会话不再被上一个会话的文件预览误判成「属于别的会话」而禁掉输入框：会话 id 还没定下来，或工作目录比预览晚到，都不算。真的被挡住时，输入框上方会写明原因，并给出「回到原会话」或「关闭预览」。启动画面淡出时不再拦点击。

Fixed new chats whose composer would not take typing. Closing or hiding the built-in browser now hands keyboard focus back to the chat page when the web page had it. Before, on macOS and Windows the caret looked like it was in the composer, but keystrokes went to the hidden page. A new chat is no longer locked by the previous chat's file preview: a session id that is not settled yet, or a workspace that arrives after the preview opened, no longer counts as "another conversation". When the composer really is blocked, a notice above it says why and offers "Return to conversation" or "Close preview". The startup screen no longer swallows clicks while it fades out.
