---
'@nomi-ai/desktop-go': patch
---

沙箱里的编程助手可以读取 `~/.npmrc`：npm 能用上配置的镜像源，nvm 不再每开一个 shell 就报 `operation not permitted`；写入 `~/.npmrc` 仍然拦截。
