---
'@nomi-ai/ai-chat': patch
'@nomi-ai/electron': patch
---

fix(workspace): 右栏「工作区」文件树列出全部文件，不再截断——原来深度优先遍历 + 2000 个上限，排在前面的大目录会吃光配额，后面的目录和根目录文件整个消失。现在只跳过依赖目录（node_modules 等）和缓存目录（.next、.turbo、.cache 等）；被 .gitignore 忽略的文件照样列出并置灰；遍历改为异步，不阻塞主进程。
