---
'@nomi-ai/desktop-go': patch
---

fix(delegate): 子任务做完后，它改动的文件和生成的图片都随结果回到对话，用户看得到，Nomi 下一轮也读得到。派给后台 Nomi 的生图任务，做完后图片会显示在对话里；只出了图、没写总结的也算完成，不再判为失败。/ When a sub-task finishes, the files it changed and the images it generated now come back to the chat with the result, so you can see them and Nomi can read them on its next turn. Image tasks handed to background Nomi now show their images in the chat; a run that produced images but wrote no summary counts as done instead of failed.
