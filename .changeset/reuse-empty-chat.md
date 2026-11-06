---
'@nomi-ai/ai-chat': patch
---

fix(chat): 新建 Nomi 对话时，如果这个工作区已经有还没说话的空对话，就切过去（挪到最上面），不再堆一个新的空对话。/ Creating a Nomi chat reuses the workspace's existing empty chat (and moves it to the top) instead of piling up another empty one.
